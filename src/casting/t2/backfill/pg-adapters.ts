/**
 * Postgres adapters of the backfill: existing edit-stats runs, the account's
 * Drive root, and the `sync_runs` store. The people cache reader is the T2 one
 * (`../pg-adapters`, cache only). Raw SQL, read-only except the run store.
 *
 * Nothing here is exercised against a real database by the unit tests: they
 * check the SQL shape and parameters with a fake client.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { RawClient } from '../../t1/pg-adapters';
import {
  type AccountReader,
  type BackfillCheckpoint,
  type BackfillCounters,
  type BackfillRunStore,
  type ExistingRun,
  type ExistingStatsReader,
  BACKFILL_STAGE,
  BACKFILL_SYNC_SOURCE,
} from './types';

export class PgExistingStatsReader implements ExistingStatsReader {
  constructor(private readonly db: RawClient) {}

  /** One row per run id of the account, with its day range and size. */
  async runs(accountId: string): Promise<ExistingRun[]> {
    return this.db.$queryRaw<ExistingRun[]>(Prisma.sql`
      SELECT sync_run_id::text                     AS "syncRunId",
             to_char(MIN(day), 'YYYY-MM-DD')       AS "minDay",
             to_char(MAX(day), 'YYYY-MM-DD')       AS "maxDay",
             COUNT(*)::int                         AS "rows"
        FROM drive_edit_stats
       WHERE account_id = ${accountId}::uuid
       GROUP BY sync_run_id
       ORDER BY MIN(day), sync_run_id
    `);
  }
}

export class PgAccountReader implements AccountReader {
  constructor(private readonly db: RawClient) {}

  async driveRoot(accountId: string): Promise<string | null> {
    const rows = await this.db.$queryRaw<Array<{ driveFolderId: string | null }>>(Prisma.sql`
      SELECT drive_folder_id AS "driveFolderId" FROM accounts WHERE id = ${accountId}::uuid
    `);
    return rows[0]?.driveFolderId ?? null;
  }
}

// ── sync_runs (D3) ──────────────────────────────────────────────────────────

type SyncRunClient = Pick<PrismaClient, 'syncRun'>;

export class PgBackfillRunStore implements BackfillRunStore {
  private readonly base = new Map<string, Record<string, unknown>>();

  constructor(private readonly db: SyncRunClient) {}

  async open(details: Record<string, unknown>): Promise<string> {
    const base = { ...details, stage: BACKFILL_STAGE };
    const run = await this.db.syncRun.create({
      data: {
        source: BACKFILL_SYNC_SOURCE,
        status: 'running',
        details: base as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    this.base.set(run.id, base);
    return run.id;
  }

  async saveProgress(
    runId: string,
    checkpoint: BackfillCheckpoint,
    c: BackfillCounters,
  ): Promise<void> {
    const base = this.base.get(runId) ?? {};
    await this.db.syncRun.update({
      where: { id: runId },
      data: {
        details: { ...base, checkpoint } as unknown as Prisma.InputJsonValue,
        totalScanned: c.windowsDone,
        created: c.statRows,
        skipped: 0,
        errored: 0,
      },
    });
  }

  async loadCheckpoint(runId: string): Promise<BackfillCheckpoint | null> {
    const run = await this.db.syncRun.findUnique({
      where: { id: runId },
      select: { source: true, status: true, details: true },
    });
    if (run === null) throw new Error(`sync run ${runId} not found`);
    if (run.source !== BACKFILL_SYNC_SOURCE) {
      throw new Error(`sync run ${runId} is not an edit-stats backfill run`);
    }
    if (run.status === 'success') throw new Error(`sync run ${runId} already finished`);
    const { checkpoint, ...rest } = (run.details ?? {}) as unknown as {
      checkpoint?: BackfillCheckpoint;
    } & Record<string, unknown>;
    this.base.set(runId, rest);
    await this.db.syncRun.update({ where: { id: runId }, data: { status: 'running' } });
    return checkpoint ?? null;
  }

  async finish(
    runId: string,
    status: 'success' | 'failed' | 'paused',
    c: BackfillCounters,
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
        totalScanned: c.windowsDone,
        created: c.statRows,
        skipped: 0,
        errored: 0,
      },
    });
  }
}
