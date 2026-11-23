/**
 * Newest content version of a T3 file.
 *
 * Layer 1 is append-only. When incremental T3 re-reads a file whose content changed, the
 * loader writes the new version's rows next to the old ones. Counting both keeps a person
 * who was removed from the file backed, and counts a person who is in both versions twice
 * (document count and confidence inflate). So for every T3 file only the rows of its NEWEST
 * LOAD are kept; the rows of earlier loads stay stored and are simply not counted.
 *
 * "Newest" is read from what a row really carries: the load run that wrote it
 * (`syncRunId`) and when that run started (`loadedAt`, `sync_runs.started_at`). A row has no
 * content hash or modified time, so a content version is identified by the load that wrote it.
 * Runs are ordered by `loadedAt`, ties by `syncRunId` text, so the choice is total and does not
 * depend on the row order.
 *
 * Applied AFTER `supersedeByVersion`, so every remaining row of a file has the same
 * extractor_version (the newest one): this is "per extractor version". T1 and T2 rows are
 * never touched: their files are not content versions (one row set per run of the same state).
 *
 * PRECONDITION (met by the T3 loader, see docs/casting-fusion.md): a load of a changed file
 * writes EVERY claim of the new version as rows of that load. The T3 claim_hash holds the
 * ledger cell key (the content version), so a claim identical in both versions is a new row
 * of the new load, not an ignored duplicate. Rows written before that change (hash without a
 * content version) are simply the file's load of their own run, like any other.
 */
import { TIER_OF_SOURCE } from './constants';
import type { FusionEvidence } from './types';

export interface NewestLoadResult {
  kept: FusionEvidence[];
  /** T3 rows dropped because a newer load of the same file exists. */
  droppedOlderLoad: number;
}

/** Total order on loads: start time, then run id. Negative when `a` is older than `b`. */
export function compareLoad(
  a: Pick<FusionEvidence, 'loadedAt' | 'syncRunId'>,
  b: Pick<FusionEvidence, 'loadedAt' | 'syncRunId'>,
): number {
  if (a.loadedAt !== b.loadedAt) return a.loadedAt < b.loadedAt ? -1 : 1;
  return a.syncRunId === b.syncRunId ? 0 : a.syncRunId < b.syncRunId ? -1 : 1;
}

export function keepNewestLoadPerFile(rows: readonly FusionEvidence[]): NewestLoadResult {
  const newest = new Map<string, FusionEvidence>();
  for (const r of rows) {
    if (TIER_OF_SOURCE[r.source] !== 'T3') continue;
    const cur = newest.get(r.fileId);
    if (cur === undefined || compareLoad(r, cur) > 0) newest.set(r.fileId, r);
  }
  const kept = rows.filter((r) => {
    if (TIER_OF_SOURCE[r.source] !== 'T3') return true;
    return (newest.get(r.fileId) as FusionEvidence).syncRunId === r.syncRunId;
  });
  return { kept, droppedOlderLoad: rows.length - kept.length };
}
