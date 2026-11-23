/**
 * Postgres adapters for the fusion stage: Layer 1 reader, accounts / campaigns /
 * staff readers, the Layer 2 writer and the `sync_runs` store.
 *
 * Raw SQL on purpose, like the T1 / T2 adapters: `evidence`, `experience` and
 * `experience_evidence_links` exist only after the UB migration (gub-schemas
 * 1.26.0), and the generated Prisma client of this repo's pinned package does not
 * know them. Raw SQL keeps the stage compiling and fails with a clear Postgres
 * error (42P01, relation "evidence" does not exist) instead of a late P2022.
 *
 * DEPLOY ORDER (the P2022 trap): apply the UB migration to the environment's
 * database BEFORE running this stage, in either mode: dry-run reads `evidence` too.
 *
 * Nothing here is exercised against a real database by the unit tests: they check
 * the SQL shape and parameters with a fake client.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { EXPERIENCE_INSERT_BATCH, LINK_INSERT_BATCH, FUSION_SYNC_SOURCE } from './constants';
import { linkId } from './fuse';
import { PgStatsReader } from '../t2/pg-adapters';
import type { RawClient } from '../t1/pg-adapters';
import type {
  ActivityHorizon,
  CatalogLoader,
  EvidenceReader,
  ExperienceWriter,
  FusedClaim,
  FusionCampaign,
  FusionCatalog,
  FusionEvidence,
  FusionPiece,
  FusionRunStore,
  FusionStaff,
  RunCounts,
  RunStatus,
  StaffLoader,
  WriteCounts,
} from './types';
import {
  EVIDENCE_SOURCES,
  PERSON_KINDS,
  ROLE_NORMS,
  SENIORITIES,
  WITHHELD_REASONS,
  type EvidenceSource,
  type PersonKind,
  type RoleNorm,
  type Seniority,
  type WithheldReason,
} from './vocab';

export type { RawClient };

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A value outside a closed set means the vocabulary drifted from the table: a bug, never data. */
function inSet<T extends string>(set: readonly T[], value: string | null, what: string): T | null {
  if (value === null) return null;
  if (!(set as readonly string[]).includes(value))
    throw new Error(`unknown ${what} in Layer 1: ${value}`);
  return value as T;
}

// ── Layer 1 ─────────────────────────────────────────────────────────────────

interface EvidenceDbRow {
  id: string;
  staffId: string | null;
  personKind: string;
  accountId: string;
  jobNumber: string | null;
  campaignId: string | null;
  pieceId: string | null;
  roleNorm: string | null;
  seniority: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  source: string;
  fileId: string;
  location: string | null;
  confidence: number;
  hasQuote: boolean;
  hasRole: boolean;
  withheldReason: string | null;
  extractorVersion: string;
  syncRunId: string;
  loadedAt: string;
}

export class PgEvidenceReader implements EvidenceReader {
  constructor(private readonly db: RawClient) {}

  /**
   * One account, keyset-paged by id. Selects only what the formula reads: no raw
   * name, no quote, no raw role text (only whether a quote and a role are present).
   * Each row also carries its load run and the run's start (`sync_runs`, a RESTRICT
   * foreign key, so the join drops nothing): `keepNewestLoadPerFile` orders loads by it.
   */
  async readPage(
    accountId: string,
    afterId: string | null,
    limit: number,
  ): Promise<FusionEvidence[]> {
    const rows = await this.db.$queryRaw<EvidenceDbRow[]>(Prisma.sql`
      SELECT e.id,
             e.staff_id           AS "staffId",
             e.person_kind        AS "personKind",
             e.account_id         AS "accountId",
             e.job_number         AS "jobNumber",
             e.campaign_id        AS "campaignId",
             e.piece_id           AS "pieceId",
             e.role_norm          AS "roleNorm",
             e.seniority,
             to_char(e.period_start, 'YYYY-MM-DD') AS "periodStart",
             to_char(e.period_end, 'YYYY-MM-DD')   AS "periodEnd",
             e.source,
             e.file_id            AS "fileId",
             e.location,
             e.confidence,
             (e.quote IS NOT NULL)    AS "hasQuote",
             (e.role_raw IS NOT NULL) AS "hasRole",
             e.withheld_reason    AS "withheldReason",
             e.extractor_version  AS "extractorVersion",
             e.sync_run_id::text  AS "syncRunId",
             to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "loadedAt"
        FROM evidence e
        JOIN sync_runs s ON s.id = e.sync_run_id
       WHERE e.account_id = ${accountId}::uuid
         AND e.id > ${afterId ?? NIL_UUID}::uuid
       ORDER BY e.id
       LIMIT ${limit}
    `);
    return rows.map((r): FusionEvidence => ({
      id: r.id,
      staffId: r.staffId,
      personKind: inSet<PersonKind>(PERSON_KINDS, r.personKind, 'person_kind') as PersonKind,
      accountId: r.accountId,
      jobNumber: r.jobNumber,
      campaignId: r.campaignId,
      pieceId: r.pieceId,
      roleNorm: inSet<RoleNorm>(ROLE_NORMS, r.roleNorm, 'role_norm'),
      seniority: inSet<Seniority>(SENIORITIES, r.seniority, 'seniority'),
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      source: inSet<EvidenceSource>(EVIDENCE_SOURCES, r.source, 'source') as EvidenceSource,
      fileId: r.fileId,
      location: r.location,
      confidence: Number(r.confidence),
      hasQuote: r.hasQuote === true,
      hasRole: r.hasRole === true,
      withheldReason: inSet<WithheldReason>(WITHHELD_REASONS, r.withheldReason, 'withheld_reason'),
      extractorVersion: r.extractorVersion,
      syncRunId: r.syncRunId,
      loadedAt: r.loadedAt,
    }));
  }
}

// ── accounts database ───────────────────────────────────────────────────────

export class PgCatalogLoader implements CatalogLoader {
  constructor(private readonly db: RawClient) {}

  async load(accountId: string): Promise<FusionCatalog> {
    const accounts = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM accounts WHERE id = ${accountId}::uuid
    `);
    const campaigns = await this.db.$queryRaw<
      Array<{
        id: string;
        status: string | null;
        awardedAt: string | null;
        liveAt: string | null;
        endsAt: string | null;
      }>
    >(Prisma.sql`
      SELECT id,
             status,
             to_char(awarded_at, 'YYYY-MM-DD') AS "awardedAt",
             to_char(live_at, 'YYYY-MM-DD')    AS "liveAt",
             to_char(ends_at, 'YYYY-MM-DD')    AS "endsAt"
        FROM campaigns
       WHERE account_id = ${accountId}::uuid
       ORDER BY id
    `);
    const pieces = await this.db.$queryRaw<
      Array<{ id: string; campaignId: string; jobNumber: string | null }>
    >(Prisma.sql`
      SELECT p.id, p.campaign_id AS "campaignId", p.job_number AS "jobNumber"
        FROM campaign_pieces p
        JOIN campaigns c ON c.id = p.campaign_id
       WHERE c.account_id = ${accountId}::uuid
       ORDER BY p.id
    `);
    const account = accounts[0];
    return {
      account: account === undefined ? null : { id: account.id },
      campaigns: campaigns.map((c): FusionCampaign => ({
        id: c.id,
        accountId,
        status: c.status,
        awardedAt: c.awardedAt,
        liveAt: c.liveAt,
        endsAt: c.endsAt,
      })),
      pieces: pieces.map((p): FusionPiece => ({
        id: p.id,
        campaignId: p.campaignId,
        jobNumber: p.jobNumber,
      })),
    };
  }
}

/**
 * Staff as fusion reads them. Current = status active or on leave (the roster's
 * rule), a person, and not ended on or before `today`. A `started_at` that is one of
 * `unknownStartDates` is an import placeholder: it becomes null (no window check).
 */
export class PgStaffLoader implements StaffLoader {
  constructor(
    private readonly db: RawClient,
    private readonly unknownStartDates: readonly string[] = [],
  ) {}

  async load(today: string): Promise<FusionStaff[]> {
    const rows = await this.db.$queryRaw<
      Array<{
        id: string;
        startedAt: string | null;
        endedAt: string | null;
        status: string;
        isPerson: boolean;
      }>
    >(Prisma.sql`
      SELECT id,
             to_char(started_at, 'YYYY-MM-DD') AS "startedAt",
             to_char(ended_at, 'YYYY-MM-DD')   AS "endedAt",
             status,
             is_person AS "isPerson"
        FROM staff
       ORDER BY id
    `);
    return rows.map((r): FusionStaff => ({
      staffId: r.id,
      startedAt:
        r.startedAt === null || this.unknownStartDates.includes(r.startedAt) ? null : r.startedAt,
      isCurrent:
        r.isPerson &&
        (r.status === 'active' || r.status === 'on_leave') &&
        (r.endedAt === null || r.endedAt > today),
    }));
  }
}

/** First `drive_edit_stats` day of an account: the T2 horizon. Reads a table that exists today. */
export class PgActivityHorizon implements ActivityHorizon {
  private readonly stats: PgStatsReader;
  constructor(db: RawClient) {
    this.stats = new PgStatsReader(db);
  }
  async startOf(accountId: string): Promise<string | null> {
    return (await this.stats.range(accountId))?.minDay ?? null;
  }
}

// ── Layer 2 writer ──────────────────────────────────────────────────────────

/** The part of the Prisma client the writer needs: an interactive transaction of raw statements. */
export type TxClient = {
  $transaction<T>(
    fn: (tx: Pick<PrismaClient, '$executeRaw'>) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
};

/** A large account's rebuild must not hit Prisma's 5 s default transaction timeout. */
export const WRITE_TX_OPTIONS = { maxWait: 30_000, timeout: 300_000 } as const;

export class PgExperienceWriter implements ExperienceWriter {
  constructor(private readonly db: TxClient) {}

  /**
   * One transaction per account: delete the account's rows of every OTHER
   * fusion_version, delete its rows of this version, insert the new claims, insert
   * the links. Either all of it lands or none. Links of deleted rows cascade. Before
   * the UB migration the first DELETE fails with 42P01.
   *
   * OPERATIONAL ORDER: serving reads exactly one version (the pin
   * CASTING_FUSION_VERSION), so after an apply of a NEW version the old version's
   * rows of that account are gone and the pinned read returns nothing for it until
   * the pin is switched. See docs/casting-fusion.md.
   */
  async replaceAccount(args: {
    accountId: string;
    fusionVersion: string;
    syncRunId: string;
    claims: readonly FusedClaim[];
  }): Promise<WriteCounts> {
    return this.db.$transaction(async (tx) => {
      const deletedOtherVersions = await tx.$executeRaw(Prisma.sql`
        DELETE FROM experience
         WHERE account_id = ${args.accountId}::uuid
           AND fusion_version <> ${args.fusionVersion}
      `);
      const deleted = await tx.$executeRaw(Prisma.sql`
        DELETE FROM experience
         WHERE fusion_version = ${args.fusionVersion}
           AND account_id = ${args.accountId}::uuid
      `);

      let inserted = 0;
      for (let i = 0; i < args.claims.length; i += EXPERIENCE_INSERT_BATCH) {
        const part = args.claims.slice(i, i + EXPERIENCE_INSERT_BATCH);
        const tuples = part.map(
          ({ row: r }) => Prisma.sql`(
          ${r.id}::uuid, ${r.staffId}::uuid, ${r.accountId}::uuid, ${r.jobNumber},
          ${r.campaignId}::uuid, ${r.pieceId}::uuid, ${r.roleNorm}, ${r.seniority},
          ${r.periodStart}::date, ${r.periodEnd}::date, ${r.confidence}::float8, ${r.withheldReason},
          ${r.fusionVersion}, ${args.syncRunId}::uuid, ${r.experienceHash}
        )`,
        );
        inserted += await tx.$executeRaw(Prisma.sql`
          INSERT INTO experience (
            id, staff_id, account_id, job_number,
            campaign_id, piece_id, role_norm, seniority,
            period_start, period_end, confidence, withheld_reason,
            fusion_version, sync_run_id, experience_hash
          ) VALUES ${Prisma.join(tuples)}
        `);
      }

      const links = args.claims.flatMap((c) =>
        c.evidenceIds.map((e) => ({ experienceId: c.row.id, evidenceId: e })),
      );
      let linked = 0;
      for (let i = 0; i < links.length; i += LINK_INSERT_BATCH) {
        const part = links.slice(i, i + LINK_INSERT_BATCH);
        const tuples = part.map(
          (l) =>
            Prisma.sql`(${linkId(l.experienceId, l.evidenceId)}::uuid, ${l.experienceId}::uuid, ${l.evidenceId}::uuid)`,
        );
        linked += await tx.$executeRaw(Prisma.sql`
          INSERT INTO experience_evidence_links (id, experience_id, evidence_id)
          VALUES ${Prisma.join(tuples)}
        `);
      }
      return { deleted, deletedOtherVersions, inserted, links: linked };
    }, WRITE_TX_OPTIONS);
  }
}

// ── sync_runs (D3) ──────────────────────────────────────────────────────────

type SyncRunClient = Pick<PrismaClient, 'syncRun'>;

export class PgFusionRunStore implements FusionRunStore {
  constructor(private readonly db: SyncRunClient) {}

  async open(details: Record<string, unknown>): Promise<string> {
    const run = await this.db.syncRun.create({
      data: {
        source: FUSION_SYNC_SOURCE,
        status: 'running',
        details: details as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return run.id;
  }

  async finish(
    runId: string,
    status: RunStatus,
    counts: RunCounts,
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
        completedAt: new Date(),
        durationMs: run ? Date.now() - run.startedAt.getTime() : null,
        totalScanned: counts.evidenceRows,
        created: counts.inserted,
        skipped: 0,
        errored: status === 'failed' ? 1 : 0,
      },
    });
  }
}
