import { describe, expect, it } from 'vitest';
import { OverlapError, checkOverlap } from '../overlap';
import { callEstimate, estimateCalls, planWindows, windowRunId } from '../windows';
import { ACCOUNT, TODAY } from './fixtures';

const plan = (over: Partial<Parameters<typeof planWindows>[0]> = {}) =>
  planWindows({
    accountId: ACCOUNT,
    from: '2025-01-01',
    to: '2025-03-02',
    windowDays: 30,
    today: TODAY,
    ...over,
  });

describe('planWindows', () => {
  it('makes contiguous windows, oldest first, the last one shorter', () => {
    const w = plan();
    expect(w.map((x) => [x.start, x.end])).toEqual([
      ['2025-01-01', '2025-01-31'],
      ['2025-01-31', '2025-03-02'],
    ]);
    const short = plan({ to: '2025-01-11', windowDays: 7 });
    expect(short.map((x) => [x.start, x.end])).toEqual([
      ['2025-01-01', '2025-01-08'],
      ['2025-01-08', '2025-01-11'],
    ]);
    expect(w[0]!.fromIso).toBe('2025-01-01T00:00:00.000Z');
    expect(w[0]!.toIso).toBe('2025-01-31T00:00:00.000Z');
  });

  it('dates the rows by the window end', () => {
    for (const w of plan({ windowDays: 7 })) expect(w.day).toBe(w.end);
  });

  it('crosses year ends and leap days', () => {
    const w = plan({ from: '2023-12-20', to: '2024-03-05', windowDays: 30 });
    expect(w.map((x) => x.end)).toEqual(['2024-01-19', '2024-02-18', '2024-03-05']);
  });

  it('run ids are deterministic uuids, distinct per window, account and bounds', () => {
    const a = plan();
    const b = plan();
    expect(a.map((w) => w.runId)).toEqual(b.map((w) => w.runId));
    expect(new Set(a.map((w) => w.runId)).size).toBe(a.length);
    for (const w of a)
      expect(w.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    const other = plan({ accountId: '22222222-2222-4222-8222-222222222222' });
    expect(other[0]!.runId).not.toBe(a[0]!.runId);
    expect(windowRunId(ACCOUNT, a[0]!.fromIso, a[0]!.toIso)).toBe(a[0]!.runId);
  });

  it('rejects bad input', () => {
    expect(() => plan({ from: '2025-03-02', to: '2025-01-01' })).toThrow(/earlier/);
    expect(() => plan({ to: '2027-01-01' })).toThrow(/later than today/);
    expect(() => plan({ windowDays: 31 })).toThrow(RangeError);
    expect(() => plan({ windowDays: 0 })).toThrow(RangeError);
    expect(() => plan({ from: '2025-02-30' })).toThrow(/calendar date/);
    expect(() => plan({ from: '2000-01-01', to: '2026-01-01', windowDays: 1 })).toThrow(/max/);
  });
});

describe('call estimate (arithmetic only)', () => {
  it('is windows x (1 + extra pages)', () => {
    expect(estimateCalls(15, 0)).toBe(15);
    expect(estimateCalls(15, 2)).toBe(45);
    expect(estimateCalls(64, 1)).toBe(128);
    const e = callEstimate(15);
    expect(e).toMatchObject({ windows: 15, minCalls: 15, pageSize: 500, peopleApiCalls: 0 });
    expect(e.scenarios.map((s) => s.calls)).toEqual([15, 30, 60]);
    expect(e.scenarios.every((s) => s.label === '[ASSUME]')).toBe(true);
    expect(e.extraPagesPerWindow).toMatch(/MEASURE/);
  });
  it('a 450-day range is 15 windows of 30 days and 64 of 7', () => {
    expect(plan({ from: '2024-06-27', to: '2025-09-17', windowDays: 30 })).toHaveLength(15);
    expect(plan({ from: '2024-06-27', to: '2025-09-17', windowDays: 7 })).toHaveLength(64);
  });
});

describe('checkOverlap (hard error)', () => {
  const run = (id: string, day: string) => ({ syncRunId: id, minDay: day, maxDay: day, rows: 3 });

  it('passes with no existing runs', () => {
    const c = checkOverlap(plan(), []);
    expect(c).toMatchObject({ foreignRuns: 0, conflictCount: 0, latestAllowedTo: null });
  });

  it('refuses a window that overlaps an existing run and names the latest allowed --to', () => {
    // An existing seed window ended 2025-02-15 and began 30 days before: (2025-01-16, 2025-02-15].
    const existing = [run('seed-random-id', '2025-02-15')];
    expect(() => checkOverlap(plan(), existing)).toThrow(OverlapError);
    try {
      checkOverlap(plan(), existing);
    } catch (e) {
      const d = (e as OverlapError).detail;
      expect(d.earliestForeignDay).toBe('2025-02-15');
      expect(d.latestAllowedTo).toBe('2025-01-16');
      expect(d.conflictCount).toBe(2);
      expect((e as Error).message).toMatch(/--to must not be later than 2025-01-16/);
    }
  });

  it('--to exactly at the start of the earliest existing window is allowed', () => {
    const existing = [run('seed-random-id', '2025-02-15')];
    const ok = plan({ to: '2025-01-16' });
    expect(checkOverlap(ok, existing).conflictCount).toBe(0);
    expect(() => checkOverlap(plan({ to: '2025-01-17' }), existing)).toThrow(OverlapError);
  });

  it('a later existing run does not matter for windows far before it', () => {
    expect(checkOverlap(plan(), [run('x', '2026-03-01')]).conflictCount).toBe(0);
  });

  it("the plan's own run ids are exempt (a retry replaces them), foreign ones are not", () => {
    const w = plan();
    const own = w.map((x) => run(x.runId, x.day));
    const c = checkOverlap(w, own);
    expect(c).toMatchObject({ ownRunsPresent: 2, foreignRuns: 0, conflictCount: 0 });
    expect(() => checkOverlap(w, [...own, run('foreign', '2025-01-20')])).toThrow(OverlapError);
  });

  it('a different window length over the same range is refused (ids differ, ranges overlap)', () => {
    const first = plan({ windowDays: 30 });
    const existing = first.map((x) => run(x.runId, x.day));
    expect(() => checkOverlap(plan({ windowDays: 7 }), existing)).toThrow(OverlapError);
  });

  it('a smaller assumed span narrows the refusal for previously backfilled short windows', () => {
    const existing = [run('weekly', '2025-02-15')]; // a 7-day window (2025-02-08, 2025-02-15]
    expect(() => checkOverlap(plan({ to: '2025-02-08' }), existing)).toThrow(OverlapError);
    expect(checkOverlap(plan({ to: '2025-02-08' }), existing, 7).conflictCount).toBe(0);
  });

  it('a span beyond the cap is rejected', () => {
    expect(() => checkOverlap(plan(), [], 31)).toThrow(RangeError);
  });
});
