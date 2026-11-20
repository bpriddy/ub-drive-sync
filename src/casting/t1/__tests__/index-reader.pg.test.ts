/**
 * PgIndexReader against a real Postgres, with SYNTHETIC rows only.
 *
 * Skipped unless CASTING_T1_PG_URL is set. The database must be a throwaway
 * one: the test drops and recreates a minimal `drive_file_snapshots` table
 * (only the columns the reader touches, no foreign keys). The guard below lets
 * through only a host named like the scratch container, never a shared one.
 *
 *   docker network create --internal casting-s43-net-<rand>
 *   docker run --rm -d --name casting-s43-pg-<rand> --network casting-s43-net-<rand> \
 *     -e POSTGRES_PASSWORD=pw postgres:16
 *   CASTING_T1_PG_URL=postgresql://postgres:pw@casting-s43-pg-<rand>:5432/postgres \
 *     npx vitest run src/casting/t1/__tests__/index-reader.pg.test.ts
 *
 * Remove the container and the network by exact name afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PgIndexReader } from '../pg-adapters';
import type { IndexFileRow } from '../types';

const URL_ = process.env['CASTING_T1_PG_URL'];
const guardOk = (u: string): boolean => {
  const host = new URL(u).hostname;
  return host === 'localhost' || host === '127.0.0.1' || /^casting-s43-pg-/.test(host);
};

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';

interface Row {
  id?: string;
  file: string;
  account?: string;
  campaign?: string | null;
  run?: string | null;
  name?: string;
  path: string;
  by?: string | null;
  at: string;
  mod?: string;
}

describe.skipIf(!URL_)('PgIndexReader on a throwaway Postgres', () => {
  let db: PrismaClient;
  let seq = 0;

  async function insert(r: Row): Promise<void> {
    seq += 1;
    const id = r.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    await db.$executeRaw`
      INSERT INTO drive_file_snapshots
        (id, file_id, account_id, campaign_id, sync_run_id, name, mime_type, path, modified_time, modified_by, scanned_at)
      VALUES (${id}::uuid, ${r.file}, ${r.account ?? A}::uuid, ${r.campaign ?? null}::uuid, ${r.run ?? null}::uuid,
              ${r.name ?? 'a.pdf'}, 'application/pdf', ${r.path}, ${r.mod ?? '2025-04-10T10:00:00Z'}::timestamptz,
              ${r.by ?? null}, ${r.at}::timestamptz)
    `;
  }

  beforeAll(async () => {
    if (!guardOk(URL_!))
      throw new Error('refusing to run: CASTING_T1_PG_URL is not a scratch database');
    db = new PrismaClient({ datasources: { db: { url: URL_! } } });
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS drive_file_snapshots');
    await db.$executeRawUnsafe(`
      CREATE TABLE drive_file_snapshots (
        id uuid PRIMARY KEY,
        file_id text NOT NULL,
        account_id uuid,
        campaign_id uuid,
        sync_run_id uuid,
        name text NOT NULL,
        mime_type text,
        path text,
        modified_time timestamptz,
        modified_by text,
        scanned_at timestamptz NOT NULL DEFAULT now()
      )`);
    await db.$executeRawUnsafe('CREATE INDEX ON drive_file_snapshots (file_id, scanned_at DESC)');
    await db.$executeRawUnsafe('CREATE INDEX ON drive_file_snapshots (account_id)');

    // f01: v1 pair, same run: account row then the newer campaign-rooted row.
    await insert({
      file: 'f01',
      path: 'Acme / M / 2025 / X [ACME55000216] / a.pdf',
      by: 'u2@x.example',
      at: '2025-01-01T10:00:00Z',
      run: R1,
    });
    await insert({
      file: 'f01',
      path: 'Camp One / a.pdf',
      campaign: C1,
      run: R1,
      by: 'u2@x.example',
      at: '2025-01-01T10:00:05Z',
    });
    // f02: account-rooted only (v2 / catch-up shape): no run, campaign attribution kept.
    await insert({
      file: 'f02',
      path: 'Acme / Brand / b.pdf',
      name: 'b.pdf',
      campaign: C2,
      by: 'u3@x.example',
      at: '2025-02-01T10:00:00Z',
    });
    // f03: legacy only: no account-rooted row at all.
    await insert({
      file: 'f03',
      path: 'Camp One / c.pdf',
      name: 'c.pdf',
      campaign: C1,
      run: R1,
      at: '2025-01-01T10:00:06Z',
    });
    // f04: tie on scanned_at between two account-rooted rows: the higher id wins.
    await insert({
      id: '00000000-0000-4000-8000-0000000000a1',
      file: 'f04',
      path: 'Acme / T / d.pdf',
      name: 'd-low.pdf',
      at: '2025-03-01T10:00:00Z',
    });
    await insert({
      id: '00000000-0000-4000-8000-0000000000a2',
      file: 'f04',
      path: 'Acme / T / d.pdf',
      name: 'd-high.pdf',
      at: '2025-03-01T10:00:00Z',
    });
    // f05: several versions: v1 pair (old), then a newer v2 row at another path and modifier.
    await insert({
      file: 'f05',
      path: 'Acme / Old / e.pdf',
      name: 'e.pdf',
      by: 'old@x.example',
      at: '2024-01-01T10:00:00Z',
      run: R1,
    });
    await insert({
      file: 'f05',
      path: 'Camp One / e.pdf',
      name: 'e.pdf',
      campaign: C1,
      run: R1,
      by: 'old@x.example',
      at: '2024-01-01T10:00:05Z',
    });
    await insert({
      file: 'f05',
      path: 'Acme / New / e.pdf',
      name: 'e.pdf',
      campaign: C2,
      by: 'new@x.example',
      at: '2025-05-01T10:00:00Z',
    });
    // f06: v1 pair of run R1, then a LATER legacy-only campaign row of run R2: the newer row is not used.
    await insert({
      file: 'f06',
      path: 'Acme / P / f.pdf',
      name: 'f.pdf',
      by: 'first@x.example',
      at: '2024-01-01T10:00:00Z',
      run: R1,
    });
    await insert({
      file: 'f06',
      path: 'Camp One / f.pdf',
      name: 'f.pdf',
      campaign: C1,
      run: R1,
      by: 'first@x.example',
      at: '2024-01-01T10:00:05Z',
    });
    await insert({
      file: 'f06',
      path: 'Camp One / f.pdf',
      name: 'f.pdf',
      campaign: C1,
      run: R2,
      by: 'later@x.example',
      at: '2025-06-01T10:00:05Z',
    });
    // f07: another account: never returned for A.
    await insert({
      file: 'f07',
      account: B,
      path: 'Other / g.pdf',
      name: 'g.pdf',
      at: '2025-01-01T10:00:00Z',
    });
    // f08: v1 account row whose campaign scan row is from a DIFFERENT run than the account row.
    await insert({
      file: 'f08',
      path: 'Acme / Q / h.pdf',
      name: 'h.pdf',
      at: '2024-01-01T10:00:00Z',
      run: R1,
    });
    await insert({
      file: 'f08',
      path: 'Camp One / h.pdf',
      name: 'h.pdf',
      campaign: C1,
      run: R2,
      at: '2024-02-01T10:00:00Z',
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function all(limit = 1000): Promise<Map<string, IndexFileRow>> {
    const reader = new PgIndexReader(db);
    const out = new Map<string, IndexFileRow>();
    let after: string | null = null;
    for (;;) {
      const page: IndexFileRow[] = await reader.readPage(A, after, limit);
      for (const r of page) out.set(r.fileId, r);
      if (page.length < limit) return out;
      after = page[page.length - 1]!.fileId;
    }
  }

  it('a v1 pair gives the account-rooted path with the campaign of the same run', async () => {
    const r = (await all()).get('f01')!;
    expect(r).toMatchObject({
      path: 'Acme / M / 2025 / X [ACME55000216] / a.pdf',
      campaignId: C1,
      modifiedBy: 'u2@x.example',
      accountRooted: true,
      campaignFromPair: true,
      newerRowOtherRun: false,
      accountId: A,
    });
    expect(r.modifiedTime).toBeInstanceOf(Date);
  });

  it('a file with only account-rooted rows keeps its own campaign attribution', async () => {
    expect((await all()).get('f02')).toMatchObject({
      path: 'Acme / Brand / b.pdf',
      campaignId: C2,
      accountRooted: true,
      campaignFromPair: false,
    });
  });

  it('a file with only legacy rows falls back to its newest row and says so', async () => {
    expect((await all()).get('f03')).toMatchObject({
      path: 'Camp One / c.pdf',
      campaignId: C1,
      accountRooted: false,
      campaignFromPair: false,
    });
  });

  it('ties on scanned_at are broken by id, the same way on every read', async () => {
    const first = (await all()).get('f04')!;
    expect(first.name).toBe('d-high.pdf');
    expect((await all()).get('f04')!.name).toBe('d-high.pdf');
  });

  it('several versions: the newest account-rooted row wins over an older pair', async () => {
    expect((await all()).get('f05')).toMatchObject({
      path: 'Acme / New / e.pdf',
      modifiedBy: 'new@x.example',
      campaignId: C2,
      accountRooted: true,
      campaignFromPair: false,
      newerRowOtherRun: false,
    });
  });

  it('a newer legacy row of another run is not used, and is reported', async () => {
    expect((await all()).get('f06')).toMatchObject({
      path: 'Acme / P / f.pdf',
      modifiedBy: 'first@x.example',
      campaignId: C1, // the same-run pair of the chosen row, not the later run
      accountRooted: true,
      campaignFromPair: true,
      newerRowOtherRun: true,
    });
  });

  it('a campaign row of another run than the account row gives no campaign, but is reported', async () => {
    expect((await all()).get('f08')).toMatchObject({
      path: 'Acme / Q / h.pdf',
      campaignId: null,
      accountRooted: true,
      campaignFromPair: false,
      newerRowOtherRun: true,
    });
  });

  it('never returns another account', async () => {
    const rows = await all();
    expect(rows.has('f07')).toBe(false);
    expect([...rows.keys()].sort()).toEqual(['f01', 'f02', 'f03', 'f04', 'f05', 'f06', 'f08']);
  });

  it('keyset paging gives the same rows, in file order, for any page size', async () => {
    const whole = [...(await all()).values()];
    for (const size of [1, 2, 3]) {
      const reader = new PgIndexReader(db);
      const got: IndexFileRow[] = [];
      let after: string | null = null;
      for (;;) {
        const page: IndexFileRow[] = await reader.readPage(A, after, size);
        got.push(...page);
        if (page.length < size) break;
        after = page[page.length - 1]!.fileId;
      }
      expect(got).toEqual(whole);
    }
    expect(whole.map((r) => r.fileId)).toEqual([...whole.map((r) => r.fileId)].sort());
  });
});
