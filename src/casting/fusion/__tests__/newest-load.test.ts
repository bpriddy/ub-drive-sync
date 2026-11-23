import { beforeEach, describe, expect, it } from 'vitest';
import { fuse } from '../fuse';
import { compareLoad, keepNewestLoadPerFile } from '../newest-load';
import type { FusionEvidence, FusionOutput } from '../types';
import type { RoleNorm } from '../vocab';
import {
  LOADED_1,
  LOADED_2,
  PIECE,
  RUN_1,
  RUN_2,
  STAFF_A,
  STAFF_B,
  STAFF_C,
  baseInput,
  ev,
  resetIds,
  uid,
} from './fixtures';

beforeEach(resetIds);

const onPiece = { pieceId: PIECE } as const;
const OLD = { syncRunId: RUN_1, loadedAt: LOADED_1 } as const;
const NEW = { syncRunId: RUN_2, loadedAt: LOADED_2 } as const;

const t3 = (
  staffId: string,
  role: RoleNorm | null,
  fileId: string,
  load: Pick<FusionEvidence, 'syncRunId' | 'loadedAt'>,
  p: Partial<FusionEvidence> = {},
): FusionEvidence =>
  ev({
    source: 'drive_content',
    staffId,
    roleNorm: role,
    fileId,
    confidence: 0.9,
    ...onPiece,
    ...load,
    ...p,
  });
const t1 = (staffId: string, p: Partial<FusionEvidence> = {}): FusionEvidence =>
  ev({
    source: 'drive_metadata',
    staffId,
    confidence: 0.3,
    fileId: 'drive-meta',
    ...onPiece,
    ...p,
  });
const t2 = (staffId: string, p: Partial<FusionEvidence> = {}): FusionEvidence =>
  ev({ source: 'drive_activity', staffId, confidence: 0.12, fileId: 'activity', ...onPiece, ...p });

/** Everything about a claim except the row ids behind it, which differ between loads by design. */
const shape = (out: FusionOutput) =>
  out.claims.map((c) => ({
    row: c.row,
    tiers: c.tiers,
    tierScores: c.tierScores,
    v: c.validation,
  }));

const run = (evidence: FusionEvidence[]): FusionOutput => fuse({ ...baseInput(), evidence });

describe('keepNewestLoadPerFile', () => {
  it('keeps only the newest load of a T3 file, whatever the row order', () => {
    const a = t3(STAFF_A, 'copywriter', 'f1', OLD);
    const b = t3(STAFF_B, 'copywriter', 'f1', NEW);
    for (const rows of [
      [a, b],
      [b, a],
    ]) {
      const r = keepNewestLoadPerFile(rows);
      expect(r.kept).toEqual([b]);
      expect(r.droppedOlderLoad).toBe(1);
    }
  });

  it('ties on the start time fall back to the run id, deterministically', () => {
    const lo = t3(STAFF_A, 'copywriter', 'f1', { syncRunId: uid(5, 1), loadedAt: LOADED_1 });
    const hi = t3(STAFF_A, 'copywriter', 'f1', { syncRunId: uid(5, 2), loadedAt: LOADED_1 });
    expect(compareLoad(lo, hi)).toBe(-1);
    expect(keepNewestLoadPerFile([hi, lo]).kept).toEqual([hi]);
    expect(keepNewestLoadPerFile([lo, hi]).kept).toEqual([hi]);
  });

  it('is decided per file: another file keeps its own older load', () => {
    const f1Old = t3(STAFF_A, 'copywriter', 'f1', OLD);
    const f1New = t3(STAFF_B, 'copywriter', 'f1', NEW);
    const f2Old = t3(STAFF_A, 'copywriter', 'f2', OLD);
    expect(keepNewestLoadPerFile([f1Old, f1New, f2Old]).kept).toEqual([f1New, f2Old]);
  });

  it('never touches T1 or T2 rows, even with several loads of the same file id', () => {
    const rows = [
      t1(STAFF_A, { fileId: 'same', ...OLD }),
      t1(STAFF_A, { fileId: 'same', ...NEW }),
      t2(STAFF_A, { fileId: 'same', ...OLD }),
      t2(STAFF_A, { fileId: 'same', ...NEW }),
    ];
    const r = keepNewestLoadPerFile(rows);
    expect(r.kept).toEqual(rows);
    expect(r.droppedOlderLoad).toBe(0);
  });

  it('a T3 file with a single load loses nothing', () => {
    const rows = [t3(STAFF_A, 'copywriter', 'f1', OLD), t3(STAFF_B, 'copywriter', 'f1', OLD)];
    expect(keepNewestLoadPerFile(rows).kept).toEqual(rows);
  });
});

describe('fuse: newest content version of a file (fusion-v3)', () => {
  // Same project, same file. The new load carries the full new version of the file.
  const corroboration = (): FusionEvidence[] => [
    t1(STAFF_A),
    t1(STAFF_B),
    t1(STAFF_C),
    t2(STAFF_A),
    t2(STAFF_B),
    t2(STAFF_C),
  ];

  it('old + new version gives the same Layer 2 as loading only the new version', () => {
    // Old version: A and B. New version: A (re-written by the new load) and C. B was removed.
    const oldRows = [t3(STAFF_A, 'copywriter', 'f1', OLD), t3(STAFF_B, 'copywriter', 'f1', OLD)];
    const newRows = [t3(STAFF_A, 'copywriter', 'f1', NEW), t3(STAFF_C, 'copywriter', 'f1', NEW)];
    const both = run([...corroboration(), ...oldRows, ...newRows]);
    const onlyNew = run([...corroboration(), ...newRows]);
    expect(shape(both)).toEqual(shape(onlyNew));
    expect(both.metrics.olderContentVersion).toBe(2);
    expect(onlyNew.metrics.olderContentVersion).toBe(0);
  });

  it('a person only in the old version gets no claim from the old version alone', () => {
    const rows = [
      ...corroboration(),
      t3(STAFF_B, 'copywriter', 'f1', OLD),
      t3(STAFF_A, 'copywriter', 'f1', NEW),
    ];
    const out = run(rows);
    const b = out.claims.filter((c) => c.row.staffId === STAFF_B);
    // B keeps no content row: only presence rows remain, and presence-only claims are not stored.
    expect(b).toEqual([]);
    expect(out.claims.some((c) => c.row.staffId === STAFF_A && c.row.withheldReason === null)).toBe(
      true,
    );
    // The old row stays out of every claim's evidence (it is stored in Layer 1, not counted).
    const oldRow = rows[6] as FusionEvidence;
    expect(out.claims.flatMap((c) => c.evidenceIds)).not.toContain(oldRow.id);
  });

  it('a person in both versions is not double-counted: one file, no breadth bonus, no inflation', () => {
    const twice = run([
      ...corroboration(),
      t3(STAFF_A, 'copywriter', 'f1', OLD),
      t3(STAFF_A, 'copywriter', 'f1', NEW, { location: 'slide 2' }),
    ]);
    const once = run([
      ...corroboration(),
      t3(STAFF_A, 'copywriter', 'f1', NEW, { location: 'slide 2' }),
    ]);
    expect(shape(twice)).toEqual(shape(once));
    const claim = twice.claims.find((c) => c.row.staffId === STAFF_A)!;
    expect(claim.evidenceIds).toHaveLength(1 + 2); // the new T3 row + T1 + T2 presence
    expect(twice.metrics.crossDocumentAgreement.withTwoFiles).toBe(0);
  });

  it('a claim that rests on the older version of one file and on another file keeps the other file', () => {
    const rows = [
      ...corroboration(),
      t3(STAFF_B, 'copywriter', 'f1', OLD), // removed from f1 in the new version
      t3(STAFF_A, 'copywriter', 'f1', NEW),
      t3(STAFF_B, 'copywriter', 'f2', OLD), // f2 was never re-read: its only load is the old one
    ];
    const out = run(rows);
    const b = out.claims.find((c) => c.row.staffId === STAFF_B)!;
    expect(b).toBeDefined();
    expect(b.row.withheldReason).toBeNull();
    expect(b.evidenceIds).toContain((rows[8] as FusionEvidence).id);
    expect(b.evidenceIds).not.toContain((rows[6] as FusionEvidence).id);
  });

  it('T1 and T2 rows with different runs are all still counted', () => {
    const base = [t3(STAFF_A, 'copywriter', 'f1', NEW)];
    const plain = run([t1(STAFF_A), t2(STAFF_A), ...base]);
    const reloaded = run([
      t1(STAFF_A, OLD),
      t1(STAFF_A, { ...NEW, fileId: 'drive-meta' }),
      t2(STAFF_A, OLD),
      t2(STAFF_A, { ...NEW, fileId: 'activity' }),
      ...base,
    ]);
    expect(reloaded.metrics.olderContentVersion).toBe(0);
    expect(reloaded.metrics.byTier.T1.rows).toBe(2);
    expect(reloaded.metrics.byTier.T2.rows).toBe(2);
    expect(plain.metrics.byTier.T1.rows).toBe(1);
  });

  it('applies after the extractor supersede: the newest extractor version wins first', () => {
    // v2 rows of f1 exist only in the OLD load, v1 rows in the NEW load: the newer extractor
    // version decides which rows of the file remain, then the newest load among those.
    const v2 = t3(STAFF_A, 'copywriter', 'f1', OLD, { extractorVersion: 't3-v2' });
    const v1 = t3(STAFF_B, 'copywriter', 'f1', NEW, { extractorVersion: 't3-v1' });
    const out = run([...corroboration(), v1, v2]);
    expect(out.metrics.superseded).toBe(1);
    expect(out.metrics.olderContentVersion).toBe(0);
    expect(out.claims.map((c) => c.row.staffId)).toEqual([STAFF_A]);
  });

  it('external and withheld rows of the newest load decide "newest" too', () => {
    const ext = t3(STAFF_A, 'copywriter', 'f1', NEW, {
      staffId: null,
      personKind: 'external_unresolved',
      withheldReason: 'unconfirmed',
    });
    const old = t3(STAFF_B, 'copywriter', 'f1', OLD);
    const out = run([...corroboration(), old, ext]);
    expect(out.metrics.olderContentVersion).toBe(1);
    expect(out.claims.some((c) => c.row.staffId === STAFF_B)).toBe(false);
  });

  it('is deterministic: any row order gives identical output', () => {
    const rows = [
      ...corroboration(),
      t3(STAFF_A, 'copywriter', 'f1', OLD),
      t3(STAFF_B, 'copywriter', 'f1', OLD),
      t3(STAFF_A, 'copywriter', 'f1', NEW),
      t3(STAFF_C, 'copywriter', 'f1', NEW),
    ];
    const first = run(rows);
    const reversed = run([...rows].reverse());
    const shuffled = run([...rows.slice(3), ...rows.slice(0, 3)]);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(first));
  });

  it('edit case: every person still in the new version stays, because the new load wrote the full set', () => {
    // The T3 loader puts the content version into claim_hash, so a changed file is written as
    // rows of the new load for EVERY claim, an unchanged-looking one included
    // (t3/__tests__/content-version.test.ts runs the loader and this rule together).
    const out = run([
      ...corroboration(),
      t3(STAFF_A, 'copywriter', 'f1', OLD),
      t3(STAFF_B, 'copywriter', 'f1', OLD), // still in the new version
      t3(STAFF_C, 'copywriter', 'f1', OLD), // removed in the new version
      t3(STAFF_A, 'copywriter', 'f1', NEW),
      t3(STAFF_B, 'copywriter', 'f1', NEW),
    ]);
    const served = out.claims
      .filter((c) => c.row.withheldReason === null)
      .map((c) => c.row.staffId);
    expect(served.sort()).toEqual([STAFF_A, STAFF_B].sort());
    expect(out.claims.some((c) => c.row.staffId === STAFF_C)).toBe(false);
  });
});
