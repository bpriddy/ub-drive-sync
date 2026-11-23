/**
 * Change probe of the incremental run (S9 task 1): did the file index of one account change since
 * the last successful casting T1 run for it? Read-only, counts only.
 *
 * Baseline: `started_at` of the newest SUCCESSFUL `casting_t1` sync run whose
 * `details.account_ids` names the account (T1 stamps that list since this change). Started, not
 * completed: a file that changed while the run was reading is then still counted next time.
 * Changed: a distinct file with a `drive_file_snapshots` row written after the baseline that is
 * not a "nothing changed" record (`delta_unchanged`, `content_unchanged`, `trashed`: see
 * docs/drive-file-index.md; the forward sync and the v1 scan write those for unchanged files).
 *
 * No baseline (a first run, or only runs from before `account_ids` existed) means "changed": the
 * free stages are idempotent, so the cost of a wrong "changed" is one run, never a wrong result.
 * The probe is NOT a gate on the paid stage: T3's own delta (ledgers) decides what is paid.
 *
 * Raw SQL, like the other casting adapters (only tables that exist before the casting migration).
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ChangeProbeResult } from '../run-all/run';

export type ProbeClient = Pick<PrismaClient, '$queryRaw'>;

/** `skip_reason` values of snapshot rows that record "no change" (docs/drive-file-index.md). */
export const UNCHANGED_SKIP_REASONS = ['delta_unchanged', 'content_unchanged', 'trashed'] as const;

export async function probeChanges(db: ProbeClient, accountId: string): Promise<ChangeProbeResult> {
  const base = await db.$queryRaw<{ baseline: Date | null }[]>(Prisma.sql`
    SELECT max(started_at) AS baseline
      FROM sync_runs
     WHERE source = 'casting_t1'
       AND status = 'success'
       AND details -> 'account_ids' @> to_jsonb(${accountId}::text)`);
  const baseline = base[0]?.baseline ?? null;
  if (baseline === null) return { changed: true, reason: 'no_baseline', filesChanged: null };
  const rows = await db.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`
    SELECT count(DISTINCT file_id) AS n
      FROM drive_file_snapshots
     WHERE account_id = ${accountId}::uuid
       AND scanned_at > ${baseline}
       AND (skip_reason IS NULL OR skip_reason NOT IN (${Prisma.join([...UNCHANGED_SKIP_REASONS])}))`);
  const filesChanged = Number(rows[0]?.n ?? 0);
  return filesChanged > 0
    ? { changed: true, reason: 'changed', filesChanged }
    : { changed: false, reason: 'no_change', filesChanged: 0 };
}
