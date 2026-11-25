/**
 * The whole fusion apply against a real Postgres, with SYNTHETIC rows only:
 * Layer 1 in, `staff_accounts` / `staff_campaigns` and their links out, through
 * the real adapters (reader, catalog, staff, writer, run store). It proves the
 * writer's SQL against the real tables and their CHECKs, the idempotent
 * rebuild, and that a `manual` row survives every rebuild.
 *
 * Skipped unless STAFF_WORK_PG_URL is set. The database must be a throwaway one,
 * migrated with UB's migrations up to 20261124200000_staff_work. The guard lets
 * through only localhost and a database whose name starts with
 * `staffwork_scratch`.
 *
 *   docker run --rm -d --name staffwork-scratch -e POSTGRES_PASSWORD=ci \
 *     -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16
 *   docker exec staffwork-scratch psql -U postgres -h 127.0.0.1 -c 'CREATE DATABASE staffwork_scratch'
 *   (in gcp-universal-backend) DATABASE_URL=postgresql://postgres:ci@127.0.0.1:55432/staffwork_scratch \
 *     npx prisma migrate deploy
 *   STAFF_WORK_PG_URL=postgresql://postgres:ci@127.0.0.1:55432/staffwork_scratch \
 *     npx vitest run src/casting/fusion/__tests__/staff-work-writer.pg.test.ts
 *
 * Stop the container by its exact name afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PgCatalogLoader,
  PgEvidenceReader,
  PgFusionRunStore,
  PgStaffLoader,
  PgStaffWorkWriter,
} from '../pg-adapters';
import { runFusion } from '../run';
import { FUSION_VERSION } from '../constants';

const URL_ = process.env['STAFF_WORK_PG_URL'];
const guardOk = (u: string): boolean => {
  const url = new URL(u);
  return (
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
    url.pathname.replace(/^\//, '').startsWith('staffwork_scratch')
  );
};

const ACC = 'a5000000-0000-4000-8000-000000000001';
const C1 = 'c5000000-0000-4000-8000-000000000001';
const C2 = 'c5000000-0000-4000-8000-000000000002';
const P1 = 'd5000000-0000-4000-8000-000000000001';
const S1 = 'e5000000-0000-4000-8000-000000000001';
const S2 = 'e5000000-0000-4000-8000-000000000002';
const ADMIN = 'e5000000-0000-4000-8000-000000000003';
const RUN = 'f5000000-0000-4000-8000-000000000001';
const MANUAL = 'b5000000-0000-4000-8000-000000000001';

describe.skipIf(!URL_)('fusion apply into the staff work tables on a throwaway Postgres', () => {
  let db: PrismaClient;
  let seq = 0;

  async function evidence(r: {
    staff: string;
    source: 'drive_metadata' | 'drive_content';
    role?: string | null;
    campaign?: string | null;
    piece?: string | null;
    job?: string | null;
    file: string;
    confidence: number;
  }): Promise<void> {
    seq += 1;
    const id = `90000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    const content = r.source === 'drive_content';
    await db.$executeRaw`
      INSERT INTO evidence (id, staff_id, raw_name, person_kind, account_id, job_number, campaign_id,
                            piece_id, role_raw, role_norm, period_start, period_end, source, file_id,
                            quote, confidence, extractor_version, sync_run_id, claim_hash)
      VALUES (${id}::uuid, ${r.staff}::uuid, 'Synthetic Person', 'staff', ${ACC}::uuid, ${r.job ?? null},
              ${r.campaign ?? null}::uuid, ${r.piece ?? null}::uuid,
              ${content && r.role ? 'Synthetic Title' : null}, ${r.role ?? null},
              '2025-02-01'::date, '2025-06-30'::date, ${r.source}, ${r.file},
              ${content ? 'a short synthetic quote' : null}, ${r.confidence},
              ${content ? 't3-v1:synthetic' : 't1-metadata-v2'}, ${RUN}::uuid, ${`claim-${seq}`})
    `;
  }

  const apply = () =>
    runFusion(
      {
        evidence: new PgEvidenceReader(db),
        catalog: new PgCatalogLoader(db),
        staff: new PgStaffLoader(db, []),
        writer: new PgStaffWorkWriter(db),
        runs: new PgFusionRunStore(db),
      },
      { accountIds: [ACC], apply: true, today: new Date('2026-11-24T10:00:00Z') },
    );

  const driveRows = async () => ({
    accounts: await db.$queryRaw<Record<string, unknown>[]>`
      SELECT id, staff_id, role_norm, withheld_reason, tiers, build_version, source
        FROM staff_accounts WHERE account_id = ${ACC}::uuid AND source = 'drive_casting' ORDER BY id`,
    campaigns: await db.$queryRaw<Record<string, unknown>[]>`
      SELECT id, staff_id, campaign_id, piece_id, job_number, role_norm, withheld_reason, build_version
        FROM staff_campaigns WHERE source = 'drive_casting' ORDER BY id`,
    links: await db.$queryRaw<{ n: number }[]>`
      SELECT (SELECT count(*) FROM staff_account_evidence_links)::int
           + (SELECT count(*) FROM staff_campaign_evidence_links)::int AS n`,
  });

  beforeAll(async () => {
    if (!guardOk(URL_!))
      throw new Error(
        'refusing to run: STAFF_WORK_PG_URL is not a localhost staffwork_scratch database',
      );
    db = new PrismaClient({ datasources: { db: { url: URL_! } } });
    await db.$executeRawUnsafe(
      `TRUNCATE staff_account_evidence_links, staff_campaign_evidence_links, staff_accounts,
                staff_campaigns, evidence CASCADE`,
    );
    await db.$executeRaw`DELETE FROM campaign_pieces WHERE campaign_id IN (${C1}::uuid, ${C2}::uuid)`;
    await db.$executeRaw`DELETE FROM campaigns WHERE id IN (${C1}::uuid, ${C2}::uuid)`;
    await db.$executeRaw`DELETE FROM accounts WHERE id = ${ACC}::uuid`;
    await db.$executeRaw`DELETE FROM sync_runs WHERE id = ${RUN}::uuid OR source = 'casting_fusion'`;
    await db.$executeRaw`DELETE FROM staff WHERE id IN (${S1}::uuid, ${S2}::uuid, ${ADMIN}::uuid)`;

    await db.$executeRaw`INSERT INTO accounts (id, name) VALUES (${ACC}::uuid, 'Synthetic Account')`;
    await db.$executeRaw`
      INSERT INTO staff (id, full_name, email, started_at, updated_at) VALUES
        (${S1}::uuid, 'Synthetic One', 'one@synthetic.example', '2020-01-01', now()),
        (${S2}::uuid, 'Synthetic Two', 'two@synthetic.example', '2020-01-01', now()),
        (${ADMIN}::uuid, 'Synthetic Admin', 'admin@synthetic.example', '2020-01-01', now())`;
    await db.$executeRaw`
      INSERT INTO campaigns (id, account_id, name, created_by, status, updated_at) VALUES
        (${C1}::uuid, ${ACC}::uuid, 'Synthetic Campaign One', ${ADMIN}::uuid, 'awarded', now()),
        (${C2}::uuid, ${ACC}::uuid, 'Synthetic Campaign Two', ${ADMIN}::uuid, 'awarded', now())`;
    await db.$executeRaw`
      INSERT INTO campaign_pieces (id, campaign_id, name, job_number, updated_at)
      VALUES (${P1}::uuid, ${C1}::uuid, 'Synthetic Piece', 'JOB-1', now())`;
    await db.$executeRaw`INSERT INTO sync_runs (id, source) VALUES (${RUN}::uuid, 'casting_t3')`;

    // S1: a copywriter on the piece, content + metadata: a served claim.
    await evidence({
      staff: S1,
      source: 'drive_content',
      role: 'copywriter',
      piece: P1,
      campaign: C1,
      job: 'JOB-1',
      file: 'f1',
      confidence: 0.95,
    });
    await evidence({
      staff: S1,
      source: 'drive_metadata',
      piece: P1,
      campaign: C1,
      job: 'JOB-1',
      file: 'f2',
      confidence: 0.9,
    });
    // S2: a producer on the second campaign, content only: uncorroborated, withheld.
    await evidence({
      staff: S2,
      source: 'drive_content',
      role: 'producer',
      campaign: C2,
      file: 'f3',
      confidence: 0.95,
    });

    // A manual row added in gub-admin before the first rebuild.
    await db.$executeRaw`
      INSERT INTO staff_campaigns (id, staff_id, campaign_id, role_norm, source, added_by_staff_id, note)
      VALUES (${MANUAL}::uuid, ${S2}::uuid, ${C1}::uuid, 'designer', 'manual', ${ADMIN}::uuid, 'synthetic')`;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('writes served and withheld rows into both tables, with links, under one fusion run', async () => {
    const report = await apply();
    expect(report.status).toBe('success');
    const rows = await driveRows();
    expect(rows.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          staff_id: S1,
          role_norm: 'copywriter',
          withheld_reason: null,
          tiers: 2,
          build_version: FUSION_VERSION,
        }),
        expect.objectContaining({
          staff_id: S2,
          role_norm: 'producer',
          withheld_reason: 'unconfirmed',
        }),
      ]),
    );
    expect(rows.accounts).toHaveLength(2);
    expect(rows.campaigns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          staff_id: S1,
          campaign_id: C1,
          piece_id: P1,
          job_number: 'JOB-1',
          withheld_reason: null,
        }),
        expect.objectContaining({
          staff_id: S2,
          campaign_id: C2,
          piece_id: null,
          withheld_reason: 'unconfirmed',
        }),
      ]),
    );
    expect(rows.campaigns).toHaveLength(2);
    expect(rows.links[0]!.n).toBeGreaterThanOrEqual(4);
    const runs = await db.$queryRaw<{ status: string; created: number }[]>`
      SELECT status, created FROM sync_runs WHERE source = 'casting_fusion'`;
    expect(runs).toEqual([{ status: 'success', created: 4 }]);
    // the manual row on C1 (C1 is one of the account's campaigns) is still there
    const manual = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM staff_campaigns WHERE id = ${MANUAL}::uuid`;
    expect(manual[0]!.n).toBe(1);
  });

  it('a second apply rebuilds the same rows (idempotent) and leaves the manual row untouched', async () => {
    const before = await driveRows();
    const manualBefore =
      await db.$queryRaw`SELECT * FROM staff_campaigns WHERE id = ${MANUAL}::uuid`;
    await apply();
    expect(await driveRows()).toEqual(before);
    expect(await db.$queryRaw`SELECT * FROM staff_campaigns WHERE id = ${MANUAL}::uuid`).toEqual(
      manualBefore,
    );
  });

  it('a rebuild after the evidence is gone empties the drive rows, and still keeps the manual row', async () => {
    await db.$executeRaw`DELETE FROM evidence WHERE account_id = ${ACC}::uuid`;
    await apply();
    const rows = await driveRows();
    expect(rows.accounts).toEqual([]);
    expect(rows.campaigns).toEqual([]);
    expect(rows.links[0]!.n).toBe(0);
    const manual = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM staff_campaigns WHERE id = ${MANUAL}::uuid AND source = 'manual'`;
    expect(manual[0]!.n).toBe(1);
  });
});
