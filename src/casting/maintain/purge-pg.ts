/**
 * Postgres store of the purge: counts, batched deletes of one account and extractor version, and
 * the `sync_runs` row that records the purge (D3). Raw SQL for `evidence` (not in the generated
 * client of the pinned schema package); `sync_runs` through the client's `syncRun` model.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { PURGE_SYNC_SOURCE, type PurgeCount, type PurgeStore } from './purge';

export type PurgeClient = Pick<PrismaClient, '$queryRaw' | '$executeRaw' | 'syncRun'>;

export class PgPurgeStore implements PurgeStore {
  constructor(private readonly db: PurgeClient) {}

  async count(accountId: string, extractorVersion: string): Promise<PurgeCount> {
    const rows = await this.db.$queryRaw<{ sync_run_id: string; n: number }[]>(Prisma.sql`
      SELECT sync_run_id::text AS sync_run_id, count(*)::int AS n
        FROM evidence
       WHERE account_id = ${accountId}::uuid AND extractor_version = ${extractorVersion}
       GROUP BY sync_run_id
       ORDER BY n DESC, sync_run_id`);
    return {
      rows: rows.reduce((a, r) => a + r.n, 0),
      syncRuns: rows.length,
      bySyncRun: rows.slice(0, 20).map((r) => ({ syncRunId: r.sync_run_id, rows: r.n })),
    };
  }

  async startRun(details: Readonly<Record<string, unknown>>): Promise<string> {
    const run = await this.db.syncRun.create({
      data: {
        source: PURGE_SYNC_SOURCE,
        status: 'running',
        details: details as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return run.id;
  }

  async deleteBatch(accountId: string, extractorVersion: string, limit: number): Promise<number> {
    return this.db.$executeRaw(Prisma.sql`
      DELETE FROM evidence
       WHERE id IN (
         SELECT id FROM evidence
          WHERE account_id = ${accountId}::uuid AND extractor_version = ${extractorVersion}
          LIMIT ${limit}
       )`);
  }

  async finishRun(
    runId: string,
    status: 'success' | 'failed',
    deleted: number,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.db.syncRun.update({
      where: { id: runId },
      data: {
        status,
        summary: `casting_purge: ${status}; rows deleted ${deleted}`,
        completedAt: new Date(),
        totalScanned: deleted,
        errored: status === 'failed' ? 1 : 0,
        details: details as Prisma.InputJsonValue,
      },
    });
  }
}
