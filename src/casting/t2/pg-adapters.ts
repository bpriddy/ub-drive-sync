/**
 * Postgres adapters for the T2 stage: stats reader, file-index lookup, people
 * cache reader and the `sync_runs` store. The catalog reader, roster loader and
 * evidence writer are the T1 ones (same tables, same insert).
 *
 * Raw SQL on purpose, as in T1: `evidence` exists only after the UB migration
 * and the generated Prisma client of this repo's pinned gub-schemas does not
 * know the model.
 *
 * DEPLOY ORDER (the P2022 trap): the UB migration that creates `evidence`
 * (gub-schemas 1.23.0) must be applied to the environment's database BEFORE
 * this code runs in apply mode; before it, apply fails with 42P01 on purpose.
 * Dry-run reads only tables that exist today (drive_edit_stats,
 * drive_file_snapshots without created_time, people_resource_map, campaigns,
 * campaign_pieces, staff), so it works before and after the migration.
 *
 * Nothing here is exercised against a real database by the unit tests: they
 * check the SQL shape and parameters with a fake client.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { monthStart, nextMonth } from './months';
import type { RawClient } from '../t1/pg-adapters';
import type {
  FileIndexLookup,
  IndexFileRow,
  PeopleMapReader,
  RunCounters,
  StatsCursor,
  StatsGroup,
  StatsReader,
  T2Checkpoint,
  T2RunStore,
} from './types';
import { T2_EXTRACTOR_VERSION, T2_SYNC_SOURCE } from './types';

export class PgStatsReader implements StatsReader {
  constructor(private readonly db: RawClient) {}

  async range(accountId: string): Promise<{ minDay: string; maxDay: string } | null> {
    const rows = await this.db.$queryRaw<Array<{ minDay: string | null; maxDay: string | null }>>(
      Prisma.sql`
        SELECT to_char(MIN(day), 'YYYY-MM-DD') AS "minDay",
               to_char(MAX(day), 'YYYY-MM-DD') AS "maxDay"
          FROM drive_edit_stats
         WHERE account_id = ${accountId}::uuid
      `,
    );
    const r = rows[0];
    return r?.minDay && r.maxDay ? { minDay: r.minDay, maxDay: r.maxDay } : null;
  }

  /**
   * One (file, actor) group per output row for one calendar month, keyset-paged
   * on (file_id, actor_email). The day range uses the (account_id, day) index;
   * the sort covers one month only.
   */
  async readPage(
    accountId: string,
    month: string,
    after: StatsCursor | null,
    limit: number,
  ): Promise<StatsGroup[]> {
    const from = monthStart(month);
    const to = monthStart(nextMonth(month));
    const afterFile = after?.fileId ?? '';
    const afterActor = after?.actor ?? '';
    return this.db.$queryRaw<StatsGroup[]>(Prisma.sql`
      SELECT file_id                                AS "fileId",
             actor_email                            AS "actor",
             to_char(MIN(day), 'YYYY-MM-DD')        AS "firstDay",
             to_char(MAX(day), 'YYYY-MM-DD')        AS "lastDay",
             COUNT(DISTINCT day)::int               AS "days",
             COALESCE(SUM(edit_count), 0)::int      AS "edits"
        FROM drive_edit_stats
       WHERE account_id = ${accountId}::uuid
         AND day >= ${from}::date
         AND day <  ${to}::date
         AND (file_id, actor_email) > (${afterFile}::text, ${afterActor}::text)
       GROUP BY file_id, actor_email
       ORDER BY file_id, actor_email
       LIMIT ${limit}
    `);
  }
}

export class PgFileIndexLookup implements FileIndexLookup {
  constructor(private readonly db: RawClient) {}

  /** Latest row per file for the given ids (uses the (file_id, scanned_at DESC) index). */
  async lookup(accountId: string, fileIds: readonly string[]): Promise<Map<string, IndexFileRow>> {
    const out = new Map<string, IndexFileRow>();
    if (fileIds.length === 0) return out;
    const rows = await this.db.$queryRaw<IndexFileRow[]>(Prisma.sql`
      SELECT DISTINCT ON (file_id)
             file_id        AS "fileId",
             account_id     AS "accountId",
             campaign_id    AS "campaignId",
             name,
             mime_type      AS "mimeType",
             path,
             modified_time  AS "modifiedTime",
             modified_by    AS "modifiedBy"
        FROM drive_file_snapshots
       WHERE account_id = ${accountId}::uuid
         AND file_id = ANY(${[...fileIds]}::text[])
       ORDER BY file_id, scanned_at DESC
    `);
    for (const r of rows) out.set(r.fileId, r);
    return out;
  }
}

export class PgPeopleMapReader implements PeopleMapReader {
  constructor(private readonly db: RawClient) {}

  /** Cache only: the People API is never called. Absent resources are absent from the map. */
  async lookup(resources: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (resources.length === 0) return out;
    const rows = await this.db.$queryRaw<Array<{ resource: string; email: string | null }>>(
      Prisma.sql`
        SELECT person_resource AS resource, email
          FROM people_resource_map
         WHERE person_resource = ANY(${[...resources]}::text[])
      `,
    );
    for (const r of rows) out.set(r.resource, r.email);
    return out;
  }
}

// ── sync_runs (D3) ──────────────────────────────────────────────────────────

type SyncRunClient = Pick<PrismaClient, 'syncRun'>;

interface StoredDetails {
  stage: string;
  extractor_version: string;
  checkpoint?: T2Checkpoint;
  [key: string]: unknown;
}

export class PgT2RunStore implements T2RunStore {
  private readonly base = new Map<string, Record<string, unknown>>();

  constructor(private readonly db: SyncRunClient) {}

  async open(details: Record<string, unknown>): Promise<string> {
    const base = { ...details, stage: 'casting_t2', extractor_version: T2_EXTRACTOR_VERSION };
    const run = await this.db.syncRun.create({
      data: { source: T2_SYNC_SOURCE, status: 'running', details: base as Prisma.InputJsonValue },
      select: { id: true },
    });
    this.base.set(run.id, base);
    return run.id;
  }

  async saveProgress(
    runId: string,
    checkpoint: T2Checkpoint,
    counters: RunCounters,
  ): Promise<void> {
    const base = this.base.get(runId) ?? {};
    await this.db.syncRun.update({
      where: { id: runId },
      data: {
        details: { ...base, checkpoint } as unknown as Prisma.InputJsonValue,
        totalScanned: counters.filesSeen,
        created: counters.rowsInserted,
        skipped: counters.rowsDuplicate,
        errored: counters.rowsFailed,
      },
    });
  }

  async loadCheckpoint(runId: string): Promise<T2Checkpoint | null> {
    const run = await this.db.syncRun.findUnique({
      where: { id: runId },
      select: { source: true, status: true, details: true },
    });
    if (run === null) throw new Error(`sync run ${runId} not found`);
    if (run.source !== T2_SYNC_SOURCE) throw new Error(`sync run ${runId} is not a casting T2 run`);
    if (run.status === 'success') throw new Error(`sync run ${runId} already finished`);
    const details = (run.details ?? {}) as unknown as StoredDetails;
    const { checkpoint, ...rest } = details;
    this.base.set(runId, rest);
    await this.db.syncRun.update({ where: { id: runId }, data: { status: 'running' } });
    return checkpoint ?? null;
  }

  async finish(
    runId: string,
    status: 'success' | 'failed' | 'paused',
    counters: RunCounters,
    summary: string,
  ): Promise<void> {
    const run = await this.db.syncRun.findUnique({
      where: { id: runId },
      select: { startedAt: true },
    });
    await this.db.syncRun.update({
      where: { id: runId },
      data: {
        status,
        summary,
        completedAt: status === 'paused' ? null : new Date(),
        durationMs: run ? Date.now() - run.startedAt.getTime() : null,
        totalScanned: counters.filesSeen,
        created: counters.rowsInserted,
        skipped: counters.rowsDuplicate,
        errored: counters.rowsFailed,
      },
    });
  }
}
