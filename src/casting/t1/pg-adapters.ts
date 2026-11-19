/**
 * Postgres adapters for the T1 stage: file index reader, catalog reader, roster
 * loader, evidence writer and the `sync_runs` store.
 *
 * Raw SQL on purpose: the `evidence` table (and `drive_file_snapshots.created_time`)
 * exist only after the UB migration, and the generated Prisma client of this
 * repo's pinned gub-schemas does not know the model yet. Raw SQL keeps the
 * stage compiling against the pinned package and fails with a clear Postgres
 * error (42P01, relation "evidence" does not exist) instead of a late P2022.
 *
 * DEPLOY ORDER (the P2022 trap): the UB migration that creates `evidence`
 * (gub-schemas 1.23.0, migration owner gcp-universal-backend) must be applied to
 * the environment's database BEFORE this code is deployed or run in apply mode.
 * Dry-run reads only tables that exist today (drive_file_snapshots, campaigns,
 * campaign_pieces, staff) and does not select `created_time`, so it works
 * before and after the migration.
 *
 * Nothing here is exercised against a real database by the unit tests: they
 * check the SQL shape and parameters with a fake client.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { RosterEntry } from '../identity';
import {
  type CampaignInfo,
  type CatalogReader,
  type EvidenceInsertRow,
  type EvidenceWriter,
  type IndexFileRow,
  type IndexReader,
  type PieceInfo,
  type ProjectCatalog,
  type RunCounters,
  type RunStore,
  type T1Checkpoint,
  T1_EXTRACTOR_VERSION,
  T1_SYNC_SOURCE,
} from './types';

export type RawClient = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

const isoDay = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

// ── file index ──────────────────────────────────────────────────────────────

export class PgIndexReader implements IndexReader {
  constructor(private readonly db: RawClient) {}

  /**
   * Latest row per file of one account, keyset-paged by file id. Uses the
   * (file_id, scanned_at DESC) index. `created_time` is not selected: T1 does
   * not use it (not a project date), so the read also works before the migration.
   */
  async readPage(
    accountId: string,
    afterFileId: string | null,
    limit: number,
  ): Promise<IndexFileRow[]> {
    const after = afterFileId ?? '';
    return this.db.$queryRaw<IndexFileRow[]>(Prisma.sql`
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
         AND file_id > ${after}
       ORDER BY file_id, scanned_at DESC
       LIMIT ${limit}
    `);
  }
}

// ── campaigns and pieces ────────────────────────────────────────────────────

export class PgCatalogReader implements CatalogReader {
  constructor(private readonly db: RawClient) {}

  async load(accountId: string): Promise<ProjectCatalog> {
    const campaigns = await this.db.$queryRaw<
      Array<{ id: string; awardedAt: Date | null; liveAt: Date | null; endsAt: Date | null }>
    >(Prisma.sql`
      SELECT id, awarded_at AS "awardedAt", live_at AS "liveAt", ends_at AS "endsAt"
        FROM campaigns
       WHERE account_id = ${accountId}::uuid
       ORDER BY id
    `);
    const pieces = await this.db.$queryRaw<
      Array<{ id: string; campaignId: string; jobNumber: string }>
    >(
      Prisma.sql`
        SELECT p.id, p.campaign_id AS "campaignId", p.job_number AS "jobNumber"
          FROM campaign_pieces p
          JOIN campaigns c ON c.id = p.campaign_id
         WHERE c.account_id = ${accountId}::uuid
           AND p.job_number IS NOT NULL
         ORDER BY p.id
      `,
    );
    return {
      campaigns: campaigns.map((c): CampaignInfo => ({
        id: c.id,
        awardedAt: isoDay(c.awardedAt),
        liveAt: isoDay(c.liveAt),
        endsAt: isoDay(c.endsAt),
      })),
      pieces: pieces.map((p): PieceInfo => ({
        id: p.id,
        campaignId: p.campaignId,
        jobNumber: p.jobNumber,
      })),
    };
  }
}

// ── roster ──────────────────────────────────────────────────────────────────

/** The staff table as S3 roster entries. Service accounts come through with isPerson=false. */
export async function loadRoster(db: RawClient): Promise<RosterEntry[]> {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      fullName: string;
      email: string | null;
      startedAt: Date;
      endedAt: Date | null;
      status: string;
      isPerson: boolean;
    }>
  >(Prisma.sql`
    SELECT id,
           full_name  AS "fullName",
           email,
           started_at AS "startedAt",
           ended_at   AS "endedAt",
           status,
           is_person  AS "isPerson"
      FROM staff
     ORDER BY id
  `);
  return rows.map((r): RosterEntry => ({
    staffId: r.id,
    fullName: r.fullName,
    email: r.email,
    startedAt: r.startedAt.toISOString().slice(0, 10),
    endedAt: isoDay(r.endedAt),
    isActive: r.status === 'active' || r.status === 'on_leave',
    isPerson: r.isPerson,
  }));
}

// ── evidence writer ─────────────────────────────────────────────────────────

export class PgEvidenceWriter implements EvidenceWriter {
  constructor(private readonly db: RawClient) {}

  /**
   * One multi-row INSERT, `ON CONFLICT (extractor_version, claim_hash) DO NOTHING`.
   * Returns how many rows were actually inserted; the rest already existed.
   * Append-only: there is no UPDATE path.
   */
  async insertBatch(rows: readonly EvidenceInsertRow[]): Promise<{ inserted: number }> {
    if (rows.length === 0) return { inserted: 0 };
    const tuples = rows.map(
      (r) => Prisma.sql`(
        ${randomUUID()}::uuid, ${r.staffId}::uuid, ${r.rawName}, ${r.personKind}, ${r.accountId}::uuid,
        ${r.jobNumber}, ${r.campaignId}::uuid, ${r.pieceId}::uuid, ${r.roleRaw}, ${r.roleNorm},
        ${r.seniority}, ${r.periodStart}::date, ${r.periodEnd}::date, ${r.source}, ${r.fileId},
        ${r.location}, ${r.quote}, ${r.confidence}::float8, ${r.withheldReason},
        ${r.extractorVersion}, ${r.syncRunId}::uuid, ${r.claimHash}
      )`,
    );
    const inserted = await this.db.$executeRaw(Prisma.sql`
      INSERT INTO evidence (
        id, staff_id, raw_name, person_kind, account_id,
        job_number, campaign_id, piece_id, role_raw, role_norm,
        seniority, period_start, period_end, source, file_id,
        location, quote, confidence, withheld_reason,
        extractor_version, sync_run_id, claim_hash
      ) VALUES ${Prisma.join(tuples)}
      ON CONFLICT (extractor_version, claim_hash) DO NOTHING
    `);
    return { inserted };
  }
}

// ── sync_runs (D3) ──────────────────────────────────────────────────────────

type SyncRunClient = Pick<PrismaClient, 'syncRun'>;

interface StoredDetails {
  stage: string;
  extractor_version: string;
  checkpoint?: T1Checkpoint;
  [key: string]: unknown;
}

export class PgRunStore implements RunStore {
  private readonly base = new Map<string, Record<string, unknown>>();

  constructor(private readonly db: SyncRunClient) {}

  async open(details: Record<string, unknown>): Promise<string> {
    const base = { ...details, stage: 'casting_t1', extractor_version: T1_EXTRACTOR_VERSION };
    const run = await this.db.syncRun.create({
      data: { source: T1_SYNC_SOURCE, status: 'running', details: base as Prisma.InputJsonValue },
      select: { id: true },
    });
    this.base.set(run.id, base);
    return run.id;
  }

  async saveProgress(
    runId: string,
    checkpoint: T1Checkpoint,
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

  async loadCheckpoint(runId: string): Promise<T1Checkpoint | null> {
    const run = await this.db.syncRun.findUnique({
      where: { id: runId },
      select: { source: true, status: true, details: true },
    });
    if (run === null) throw new Error(`sync run ${runId} not found`);
    if (run.source !== T1_SYNC_SOURCE) throw new Error(`sync run ${runId} is not a casting T1 run`);
    if (run.status === 'success') throw new Error(`sync run ${runId} already finished`);
    const details = (run.details ?? {}) as unknown as StoredDetails;
    this.base.set(runId, { ...details, checkpoint: undefined });
    await this.db.syncRun.update({ where: { id: runId }, data: { status: 'running' } });
    return details.checkpoint ?? null;
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
