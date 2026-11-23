import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { DRIFT_EXIT_BREACH, DRIFT_THRESHOLDS } from '../constants';
import { computeDrift, evaluateDrift, type DriftCounts } from '../drift';
import { PgDriftReader, type DriftClient } from '../drift-pg';
import { parseDriftArgs, runDrift, type DriftIo } from '../drift-main';

const ACCT = '11111111-1111-4111-8111-111111111111';

const counts = (
  over: Partial<DriftCounts['experience']> = {},
  t3 = { staff: 160, external_unresolved: 30, quarantined: 10 },
): DriftCounts => ({
  t3Rows: t3,
  experience: {
    total: 100,
    served: 60,
    withheldByReason: { conflicting: 15, unconfirmed: 25 },
    servedMultiTier: 54,
    confidence: { min: 0.7, p10: 0.73, p50: 0.8, p90: 0.92, max: 0.96 },
    ...over,
  },
  servedBeforeCutoff: null,
});
const META = { fusionVersion: 'fusion-v2', windowCutoff: null };

describe('computeDrift: rates are counts over counts', () => {
  it('computes the four measures and the spread', () => {
    expect(computeDrift(counts(), META)).toMatchObject({
      t3Rows: 200,
      unresolvedNameRate: 0.2,
      storedClaims: 100,
      servedCount: 60,
      withheldShare: 0.4,
      tierAgreementRate: 0.9,
      confidenceSpread: 0.19,
    });
  });
  it('empty account: rates are null, nothing divides by zero', () => {
    const r = computeDrift(
      counts(
        { total: 0, served: 0, withheldByReason: {}, servedMultiTier: 0, confidence: null },
        { staff: 0, external_unresolved: 0, quarantined: 0 },
      ),
      META,
    );
    expect(r).toMatchObject({
      unresolvedNameRate: null,
      withheldShare: null,
      tierAgreementRate: null,
      confidenceSpread: null,
    });
    expect(evaluateDrift(r, null).breaches).toEqual([]);
  });
});

describe('evaluateDrift against the named thresholds', () => {
  it('a healthy report has no breach', () => {
    expect(evaluateDrift(computeDrift(counts(), META), null)).toEqual({
      breaches: [],
      notJudged: [],
    });
  });

  it('flags each crossed limit', () => {
    const bad = computeDrift(
      counts(
        {
          served: 60,
          servedMultiTier: 6,
          confidence: { min: 0.7, p10: 0.74, p50: 0.75, p90: 0.76, max: 0.77 },
        },
        { staff: 40, external_unresolved: 150, quarantined: 10 },
      ),
      META,
    );
    const names = evaluateDrift(bad, null)
      .breaches.map((b) => b.metric)
      .sort();
    expect(names).toEqual(['confidenceSpread', 'tierAgreementRate']);
    // Account-level rates are not judged against a fixed limit, however high.
    expect(names).not.toContain('unresolvedNameRate');
  });

  it('a sample below the minimum is not judged', () => {
    const tiny = computeDrift(
      counts(
        { total: 10, served: 4, servedMultiTier: 0, withheldByReason: { conflicting: 6 } },
        { staff: 0, external_unresolved: 20, quarantined: 0 },
      ),
      META,
    );
    const v = evaluateDrift(tiny, null);
    expect(v.breaches).toEqual([]);
    expect(v.notJudged).toEqual(expect.arrayContaining(['tierAgreementRate']));
  });

  it('compares with a previous report: rate shift and a fall of the served count', () => {
    const before = computeDrift(counts(), META);
    const after = computeDrift(
      counts(
        { served: 40, total: 100, servedMultiTier: 32 },
        { staff: 100, external_unresolved: 90, quarantined: 10 },
      ),
      META,
    );
    const names = evaluateDrift(after, before).breaches.map((b) => b.metric);
    expect(names).toEqual(expect.arrayContaining(['unresolvedNameRateShift', 'servedCountFall']));
    expect(evaluateDrift(before, before).breaches).toEqual([]);
  });

  it('the thresholds are named constants and still placeholders', () => {
    expect(Object.keys(DRIFT_THRESHOLDS).sort()).toEqual([
      'confidenceSpreadMin',
      'minSample',
      'rateShiftMax',
      'servedDropMax',
      'tierAgreementRateMin',
    ]);
  });
});

describe('PgDriftReader: SELECT only, aggregates only', () => {
  it('maps the rows to counts and sends no write', async () => {
    const calls: Prisma.Sql[] = [];
    const answers: unknown[] = [
      [
        { person_kind: 'staff', n: 5 },
        { person_kind: 'external_unresolved', n: 2 },
      ],
      [
        { reason: null, n: 7 },
        { reason: 'conflicting', n: 3 },
      ],
      [{ multi: 4, min: 0.7, p10: 0.71, p50: 0.8, p90: 0.9, max: 0.95 }],
      [{ n: 2 }],
    ];
    const db = {
      $queryRaw: async (sql: Prisma.Sql) => {
        calls.push(sql);
        return answers.shift() ?? [];
      },
    } as unknown as DriftClient;
    const out = await new PgDriftReader(db).read({
      accountId: ACCT,
      fusionVersion: 'fusion-v2',
      windowCutoff: '2021-11-23',
    });
    expect(out).toEqual({
      t3Rows: { staff: 5, external_unresolved: 2, quarantined: 0 },
      experience: {
        total: 10,
        served: 7,
        withheldByReason: { conflicting: 3 },
        servedMultiTier: 4,
        confidence: { min: 0.7, p10: 0.71, p50: 0.8, p90: 0.9, max: 0.95 },
      },
      servedBeforeCutoff: 2,
    });
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
      expect(c.sql).not.toMatch(/raw_name|\bquote\b|file_id/);
      expect(c.values).toContain(ACCT);
    }
  });

  it('no cutoff: the window query is not sent', async () => {
    let n = 0;
    const db = { $queryRaw: async () => (n++, []) } as unknown as DriftClient;
    const out = await new PgDriftReader(db).read({
      accountId: ACCT,
      fusionVersion: 'fusion-v2',
      windowCutoff: null,
    });
    expect(n).toBe(3);
    expect(out.servedBeforeCutoff).toBeNull();
    expect(out.experience.confidence).toBeNull();
  });
});

describe('the command', () => {
  it('parses strictly', () => {
    expect(() => parseDriftArgs([])).toThrow(/account-id/);
    expect(() => parseDriftArgs(['--account-id', ACCT, '--apply'])).toThrow(/unknown argument/);
    expect(() => parseDriftArgs(['--account-id', ACCT, '--window-start', 'soon'])).toThrow(
      /YYYY-MM-DD/,
    );
    expect(parseDriftArgs(['--account-id', ACCT.toUpperCase()])).toMatchObject({
      accountId: ACCT,
      failOnBreach: false,
    });
  });

  const io = (c: DriftCounts, lines: string[]): DriftIo => ({
    read: async () => c,
    readPrevious: () => computeDrift(counts(), META),
    print: (l) => lines.push(l),
  });

  it('prints one counts-only JSON line and exits 0 even on a breach; 6 only with --fail-on-breach', async () => {
    const lines: string[] = [];
    const bad = counts({ confidence: { min: 0.7, p10: 0.74, p50: 0.75, p90: 0.76, max: 0.77 } });
    const base = parseDriftArgs(['--account-id', ACCT]);
    expect(await runDrift(base, io(bad, lines))).toBe(0);
    expect(await runDrift({ ...base, failOnBreach: true }, io(bad, lines))).toBe(DRIFT_EXIT_BREACH);
    expect(await runDrift({ ...base, failOnBreach: true }, io(counts(), lines))).toBe(0);
    const rec = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(rec['msg']).toBe('casting-drift report');
    expect(rec['thresholdsRatifiedByS8']).toBe(false);
    expect(lines[0]).not.toMatch(new RegExp(ACCT));
  });
});
