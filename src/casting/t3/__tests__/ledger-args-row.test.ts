import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseT3Args } from '../args';
import {
  JsonlLedger,
  assertOutsideRepo,
  cellKeyOf,
  extractorVersionOf,
  type CellRecord,
} from '../ledger';
import { assertEvidenceInvariants, claimHash, type EvidenceRowShape } from '../row';
import { toTraversedFile } from '../real-reader';
import { cand } from './helpers';

const sig = {
  promptVersion: 'v1',
  model: 'gemini-3.5-flash',
  thinkingLevel: 'LOW',
  capChars: 40_000,
};

describe('cell keys', () => {
  const c = cand({ fileId: 'f1', name: 'x', md5Checksum: 'abc' });

  it('are stable, and change with the file version, the prompt, the model, the level or the cap', () => {
    const k = cellKeyOf(c, sig);
    expect(cellKeyOf(c, sig)).toBe(k);
    expect(cellKeyOf({ ...c, md5Checksum: 'def' }, sig)).not.toBe(k);
    expect(cellKeyOf(c, { ...sig, promptVersion: 'v2' })).not.toBe(k);
    expect(cellKeyOf(c, { ...sig, model: 'gemini-3.5-flash-lite' })).not.toBe(k);
    expect(cellKeyOf(c, { ...sig, thinkingLevel: 'MINIMAL' })).not.toBe(k);
    expect(cellKeyOf(c, { ...sig, capChars: 80_000 })).not.toBe(k);
  });

  it('use modifiedTime when the file has no md5 (native documents)', () => {
    const n = cand({ fileId: 'f2', name: 'y' });
    expect(cellKeyOf(n, sig)).not.toBe(
      cellKeyOf({ ...n, modifiedTime: '2026-01-01T00:00:00Z' }, sig),
    );
  });

  it('extractor_version names prompt version, model and level', () => {
    expect(extractorVersionOf(sig)).toBe('t3-v1:gemini-3.5-flash:low');
  });
});

describe('JsonlLedger', () => {
  const rec = (key: string): CellRecord => ({
    v: 1,
    cellKey: key,
    extractorVersion: 'x',
    at: '2026-11-19T00:00:00Z',
    status: 'ok',
    reason: null,
    candidate: { fileId: 'f', accountId: 'a', createdTime: null, projectRef: undefined },
    docClass: 'gdoc',
    contentHash: 'h',
    docType: 'other',
    truncated: false,
    sentChars: 10,
    attempts: 1,
    usage: null,
    mentions: [],
    sanitizeStats: null,
    groundingStats: null,
  });

  it('round-trips records, ignores a torn last line, and refuses a directory inside the repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-ledger-'));
    const ledger = new JsonlLedger(path.join(dir, 'run1'), '/some/repo/root');
    ledger.append(rec('k1'));
    ledger.append(rec('k2'));
    fs.appendFileSync(path.join(dir, 'run1', 'cells.jsonl'), '{"v":1,"cellKey":"torn');
    expect(ledger.load().map((r) => r.cellKey)).toEqual(['k1', 'k2']);
    expect(new JsonlLedger(path.join(dir, 'run1'), '/some/repo/root').load()).toHaveLength(2);
    fs.rmSync(dir, { recursive: true });
  });

  it('assertOutsideRepo: relative paths, the repo itself and paths below it are refused', () => {
    expect(() => assertOutsideRepo('runs/x', '/r')).toThrow(/absolute/);
    expect(() => assertOutsideRepo('/r', '/r')).toThrow(/outside/);
    expect(() => assertOutsideRepo('/r/runs/x', '/r')).toThrow(/outside/);
    expect(assertOutsideRepo('/elsewhere/runs/x', '/r')).toBe('/elsewhere/runs/x');
  });
});

describe('parseT3Args', () => {
  const ok = ['--window-start', '2021-11-19'];

  it('defaults to dry-run, flash, LOW, parallel 1, base variant', () => {
    expect(parseT3Args(ok)).toMatchObject({
      mode: 'dry-run',
      model: 'gemini-3.5-flash',
      thinkingLevel: 'LOW',
      parallel: 1,
      variant: 'base',
      readText: false,
      approval: null,
    });
  });

  it('apply needs --apply plus both limits plus a ledger dir', () => {
    expect(() => parseT3Args([...ok, '--apply'])).toThrow(/max-cells/);
    expect(() => parseT3Args([...ok, '--apply', '--max-cells', '10'])).toThrow(/max-usd/);
    expect(() => parseT3Args([...ok, '--apply', '--max-cells', '10', '--max-usd', '2'])).toThrow(
      /ledger-dir/,
    );
    expect(
      parseT3Args([
        ...ok,
        '--apply',
        '--max-cells',
        '10',
        '--max-usd',
        '2',
        '--ledger-dir',
        '/x/y',
      ]),
    ).toMatchObject({
      mode: 'apply',
      approval: { maxCells: 10, maxCostUsd: 2 },
      ledgerDir: '/x/y',
    });
  });

  it('limits without --apply are an error, not a silent dry-run', () => {
    expect(() => parseT3Args([...ok, '--max-usd', '2'])).toThrow(/only mean something/);
  });

  it('rejects parallel above 2, bad levels and variants, and a missing window', () => {
    expect(() => parseT3Args([...ok, '--parallel', '3'])).toThrow(/parallel/);
    expect(() => parseT3Args([...ok, '--thinking', 'EXTREME'])).toThrow(/thinking/);
    expect(() => parseT3Args([...ok, '--variant', 'everything'])).toThrow(/variant/);
    expect(() => parseT3Args([])).toThrow(/window-start/);
    expect(parseT3Args([...ok, '--parallel', '2', '--thinking', 'minimal']).thinkingLevel).toBe(
      'MINIMAL',
    );
  });
});

describe('Layer 1 row invariants (mirror of the table CHECKs)', () => {
  const row: EvidenceRowShape = {
    staff_id: 'staff-1',
    raw_name: 'Jane Roe',
    person_kind: 'staff',
    account_id: 'a',
    job_number: null,
    campaign_id: null,
    piece_id: null,
    role_raw: 'Producer',
    role_norm: 'producer',
    seniority: null,
    period_start: null,
    period_end: null,
    source: 'drive_content',
    file_id: 'f',
    location: null,
    quote: 'q',
    confidence: 0.9,
    withheld_reason: null,
    extractor_version: 'v',
    claim_hash: 'h',
  };

  it('accepts a staff row and a withheld external row', () => {
    expect(() => assertEvidenceInvariants(row)).not.toThrow();
    expect(() =>
      assertEvidenceInvariants({
        ...row,
        staff_id: null,
        person_kind: 'external_unresolved',
        withheld_reason: 'unresolved',
      }),
    ).not.toThrow();
  });

  it('rejects every violation the DB would', () => {
    const bad = (over: Partial<EvidenceRowShape>) => () =>
      assertEvidenceInvariants({ ...row, ...over });
    expect(bad({ staff_id: null })).toThrow(/staff_id/);
    expect(bad({ person_kind: 'quarantined' })).toThrow(/staff_id/);
    expect(bad({ staff_id: null, person_kind: 'quarantined', withheld_reason: null })).toThrow(
      /withheld/,
    );
    expect(bad({ quote: 'x'.repeat(301) })).toThrow(/quote/);
    expect(bad({ confidence: 1.2 })).toThrow(/confidence/);
    expect(bad({ period_start: '2024-02-01', period_end: '2024-01-01' })).toThrow(/period/);
    expect(bad({ role_norm: 'wizard' as never })).toThrow(/role_norm/);
  });

  it('claim hash ignores case and spacing, and changes with file, location, role or period', () => {
    const k = claimHash(row);
    expect(claimHash({ ...row, raw_name: '  JANE   roe ' })).toBe(k);
    expect(claimHash({ ...row, file_id: 'g' })).not.toBe(k);
    expect(claimHash({ ...row, location: 'slide 2' })).not.toBe(k);
    expect(claimHash({ ...row, role_raw: 'Director' })).not.toBe(k);
    expect(claimHash({ ...row, period_start: '2024-01-01' })).not.toBe(k);
  });

  it('claim hash: no content version keeps the legacy hash, a content version changes it', () => {
    const k = claimHash(row);
    // Rows written before the token existed keep their identity (their hash is this exact value).
    expect(claimHash(row, null)).toBe(k);
    expect(claimHash(row, undefined)).toBe(k);
    expect(claimHash(row, 'cell-1')).not.toBe(k);
    expect(claimHash(row, 'cell-1')).toBe(claimHash(row, 'cell-1'));
    expect(claimHash(row, 'cell-1')).not.toBe(claimHash(row, 'cell-2'));
  });

  it('the legacy canonical form is pinned (an accidental change would re-insert every old row)', () => {
    expect(claimHash(row)).toBe(
      crypto
        .createHash('sha256')
        .update(JSON.stringify(['drive_content', 'f', '', 'jane roe', 'producer', '', '']))
        .digest('hex'),
    );
  });
});

describe('toTraversedFile (the real reader adapter, pure part)', () => {
  it('maps a candidate to the extractor input and drops nothing the extractor needs', () => {
    const f = toTraversedFile(
      cand({ fileId: 'f9', name: 'Deck', md5Checksum: 'abc', ancestors: ['A', 'B'] }),
    );
    expect(f).toMatchObject({
      id: 'f9',
      name: 'Deck',
      path: 'A / B',
      isFolder: false,
      md5Checksum: 'abc',
    });
  });
});
