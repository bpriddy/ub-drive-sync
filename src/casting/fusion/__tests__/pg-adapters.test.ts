import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  PgCatalogLoader,
  PgEvidenceReader,
  PgExperienceWriter,
  PgFusionRunStore,
  PgStaffLoader,
  WRITE_TX_OPTIONS,
  type RawClient,
  type TxClient,
} from '../pg-adapters';
import { fuse, linkId } from '../fuse';
import { EXPERIENCE_INSERT_BATCH, LINK_INSERT_BATCH } from '../constants';
import { ACCOUNT, STAFF_A, baseInput, ev, resetIds, uid } from './fixtures';

/** Captures the SQL the adapters build; no database is involved. */
function fakeDb(answers: unknown[] = []) {
  const calls: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (sql: Prisma.Sql) => {
      calls.push(sql);
      return answers.shift() ?? [];
    },
  } as unknown as RawClient;
  return { db, calls };
}

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: uid(9, 1),
  staffId: STAFF_A,
  personKind: 'staff',
  accountId: ACCOUNT,
  jobNumber: null,
  campaignId: null,
  pieceId: null,
  roleNorm: 'copywriter',
  seniority: null,
  periodStart: '2023-01-01',
  periodEnd: '2023-12-31',
  source: 'drive_content',
  fileId: 'f1',
  location: null,
  confidence: 0.9,
  withheldReason: null,
  extractorVersion: 't3-v1',
  syncRunId: uid(5, 1),
  loadedAt: '2026-10-01T08:00:00.000000Z',
  ...over,
});

describe('PgEvidenceReader', () => {
  it('reads one account keyset-paged by id and selects no name, quote or raw role', async () => {
    const { db, calls } = fakeDb([[dbRow()]]);
    const out = await new PgEvidenceReader(db).readPage(ACCOUNT, null, 500);
    expect(out).toHaveLength(1);
    const sql = calls[0]!;
    expect(sql.sql).toMatch(/FROM evidence e/);
    expect(sql.sql).toMatch(/JOIN sync_runs s ON s\.id = e\.sync_run_id/);
    expect(sql.sql).toMatch(/ORDER BY e\.id/);
    expect(sql.sql).toMatch(/LIMIT/);
    expect(sql.sql).not.toMatch(/raw_name/);
    // The quote and the raw role are read only as presence flags, never as text.
    const withoutFlags = sql.sql
      .replace(/\(e\.quote IS NOT NULL\)/, '')
      .replace(/\(e\.role_raw IS NOT NULL\)/, '');
    expect(withoutFlags).not.toMatch(/quote|role_raw/);
    expect(sql.values).toEqual([ACCOUNT, '00000000-0000-0000-0000-000000000000', 500]);
  });

  it('carries the load run and its start, for the newest-load rule', async () => {
    const { db, calls } = fakeDb([
      [dbRow({ syncRunId: uid(5, 2), loadedAt: '2026-11-01T08:00:00.000000Z' })],
    ]);
    const [row] = await new PgEvidenceReader(db).readPage(ACCOUNT, null, 10);
    expect(row).toMatchObject({ syncRunId: uid(5, 2), loadedAt: '2026-11-01T08:00:00.000000Z' });
    expect(calls[0]!.sql).toMatch(/s\.started_at AT TIME ZONE 'UTC'/);
  });

  it('passes the cursor on later pages', async () => {
    const { db, calls } = fakeDb([[]]);
    await new PgEvidenceReader(db).readPage(ACCOUNT, uid(9, 5), 10);
    expect(calls[0]!.values[1]).toBe(uid(9, 5));
  });

  it('a value outside a closed set is a bug, not data', async () => {
    for (const bad of [
      { roleNorm: 'wizard' },
      { source: 'drive_magic' },
      { personKind: 'robot' },
      { seniority: 'god' },
      { withheldReason: 'meh' },
    ]) {
      const { db } = fakeDb([[dbRow(bad)]]);
      await expect(new PgEvidenceReader(db).readPage(ACCOUNT, null, 10)).rejects.toThrow('unknown');
    }
  });

  it('confidence comes back as a number', async () => {
    const { db } = fakeDb([[dbRow({ confidence: '0.75' })]]);
    expect((await new PgEvidenceReader(db).readPage(ACCOUNT, null, 10))[0]?.confidence).toBe(0.75);
  });
});

describe('PgCatalogLoader', () => {
  it('reads the account id, the campaign status and dates, and pieces', async () => {
    const { db, calls } = fakeDb([
      [{ id: ACCOUNT }],
      [
        {
          id: uid(3, 1),
          status: 'lost',
          awardedAt: null,
          liveAt: null,
          endsAt: null,
        },
      ],
      [{ id: uid(4, 1), campaignId: uid(3, 1), jobNumber: null }],
    ]);
    const out = await new PgCatalogLoader(db).load(ACCOUNT);
    expect(out.account).toEqual({ id: ACCOUNT });
    expect(out.campaigns[0]).toMatchObject({ accountId: ACCOUNT, status: 'lost' });
    expect(out.campaigns[0]).not.toHaveProperty('budget');
    expect(out.pieces[0]?.jobNumber).toBeNull();
    expect(calls.map((c) => c.sql.match(/FROM (\w+)/)?.[1])).toEqual([
      'accounts',
      'campaigns',
      'campaign_pieces',
    ]);
  });

  it('an unknown account gives a null account, not an error', async () => {
    const { db } = fakeDb([[], [], []]);
    expect((await new PgCatalogLoader(db).load(ACCOUNT)).account).toBeNull();
  });
});

describe('PgStaffLoader', () => {
  const row = (o: Record<string, unknown>) => ({
    id: uid(2, 1),
    startedAt: '2019-03-01',
    endedAt: null,
    status: 'active',
    isPerson: true,
    ...o,
  });
  const load = async (rows: unknown[], unknown: string[] = []) => {
    const { db } = fakeDb([rows]);
    return new PgStaffLoader(db, unknown).load('2026-11-19');
  };

  it('current = a person, active or on leave, not ended', async () => {
    const out = await load([
      row({ id: uid(2, 1) }),
      row({ id: uid(2, 2), status: 'on_leave' }),
      row({ id: uid(2, 3), status: 'inactive' }),
      row({ id: uid(2, 4), isPerson: false }),
      row({ id: uid(2, 5), endedAt: '2026-11-19' }),
      row({ id: uid(2, 6), endedAt: '2026-11-20' }),
    ]);
    expect(out.map((s) => s.isCurrent)).toEqual([true, true, false, false, false, true]);
  });

  it('an import placeholder start date becomes unknown', async () => {
    const out = await load(
      [row({ startedAt: '2020-01-01' }), row({ id: uid(2, 2), startedAt: '2021-05-05' })],
      ['2020-01-01'],
    );
    expect(out.map((s) => s.startedAt)).toEqual([null, '2021-05-05']);
  });
});

/** A transaction client that records every statement in order. */
function fakeTx(affectedFor: (sql: Prisma.Sql) => number = () => 1) {
  const log: Prisma.Sql[] = [];
  const state = { transactions: 0 };
  let usedOptions: unknown = null;
  const tx = {
    $executeRaw: async (sql: Prisma.Sql) => {
      log.push(sql);
      return affectedFor(sql);
    },
  };
  const db: TxClient = {
    $transaction: (async (fn: (t: typeof tx) => Promise<unknown>, options?: unknown) => {
      usedOptions = options;
      state.transactions += 1;
      return fn(tx);
    }) as TxClient['$transaction'],
  };
  return { db, log, state, options: () => usedOptions };
}

describe('PgExperienceWriter', () => {
  const claims = () => {
    resetIds();
    return fuse(
      baseInput([
        ev({
          source: 'drive_content',
          roleNorm: 'copywriter',
          confidence: 0.9,
          pieceId: uid(4, 1),
        }),
        ev({ source: 'drive_metadata', confidence: 0.3, pieceId: uid(4, 1) }),
      ]),
    ).claims;
  };

  it('deletes other versions, then this version, then inserts rows, then links, in one transaction', async () => {
    const { db, log, options } = fakeTx((sql) =>
      sql.sql.includes('<>')
        ? 7
        : sql.sql.includes('DELETE')
          ? 4
          : sql.sql.includes('experience_evidence_links')
            ? 2
            : 1,
    );
    const c = claims();
    const out = await new PgExperienceWriter(db).replaceAccount({
      accountId: ACCOUNT,
      fusionVersion: 'fusion-v1',
      syncRunId: uid(7, 7),
      claims: c,
    });
    expect(out).toEqual({ deleted: 4, deletedOtherVersions: 7, inserted: 1, links: 2 });
    expect(log.map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'DELETE FROM experience',
      'DELETE FROM experience',
      'INSERT INTO experience',
      'INSERT INTO experience_evidence_links',
    ]);
    // 1: every OTHER version of the account (links cascade); 2: this version of the account
    expect(log[0]!.sql).toMatch(/account_id = .*\s+AND fusion_version <> /s);
    expect(log[0]!.values).toEqual([ACCOUNT, 'fusion-v1']);
    expect(log[1]!.sql).toMatch(/fusion_version = /);
    expect(log[1]!.sql).not.toMatch(/<>/);
    expect(log[1]!.values).toEqual(['fusion-v1', ACCOUNT]);
    expect(options()).toEqual(WRITE_TX_OPTIONS);
    expect(WRITE_TX_OPTIONS.timeout).toBeGreaterThan(5000);
  });

  it('every statement, both deletes included, runs inside ONE transaction', async () => {
    const { db, log, state } = fakeTx();
    await new PgExperienceWriter(db).replaceAccount({
      accountId: ACCOUNT,
      fusionVersion: 'fusion-v2',
      syncRunId: uid(7, 7),
      claims: claims(),
    });
    expect(state.transactions).toBe(1);
    expect(log).toHaveLength(4);
  });

  it('a failure after the deletes propagates out of the transaction (Prisma rolls it back)', async () => {
    const { db } = fakeTx((sql) => {
      if (/INSERT INTO experience \(/.test(sql.sql)) throw new Error('insert failed');
      return 1;
    });
    await expect(
      new PgExperienceWriter(db).replaceAccount({
        accountId: ACCOUNT,
        fusionVersion: 'fusion-v2',
        syncRunId: uid(7, 7),
        claims: claims(),
      }),
    ).rejects.toThrow('insert failed');
  });

  it('writes the run id and the derived link ids', async () => {
    const { db, log } = fakeTx();
    const c = claims();
    await new PgExperienceWriter(db).replaceAccount({
      accountId: ACCOUNT,
      fusionVersion: 'fusion-v1',
      syncRunId: uid(7, 7),
      claims: c,
    });
    expect(log[2]!.values).toContain(uid(7, 7));
    for (const col of ['account_category', 'project_type', 'outcome', 'budget_band'])
      expect(log[2]!.sql).not.toContain(col);
    expect(log[2]!.values).toContain(c[0]!.row.experienceHash);
    const first = c[0]!.evidenceIds[0]!;
    expect(log[3]!.values).toContain(linkId(c[0]!.row.id, first));
  });

  it('no claims: only the two deletes run (a rebuild may legitimately end empty)', async () => {
    const { db, log } = fakeTx();
    const out = await new PgExperienceWriter(db).replaceAccount({
      accountId: ACCOUNT,
      fusionVersion: 'fusion-v1',
      syncRunId: uid(7, 7),
      claims: [],
    });
    expect(log).toHaveLength(2);
    expect(out.inserted).toBe(0);
  });

  it('splits large writes into batches below the parameter limit', async () => {
    const { db, log } = fakeTx();
    const base = claims()[0]!;
    const many = Array.from({ length: EXPERIENCE_INSERT_BATCH + 1 }, (_, i) => ({
      ...base,
      row: { ...base.row, id: uid(12, i + 1), experienceHash: `h${i}` },
      evidenceIds: [uid(9, 1)],
    }));
    await new PgExperienceWriter(db).replaceAccount({
      accountId: ACCOUNT,
      fusionVersion: 'fusion-v1',
      syncRunId: uid(7, 7),
      claims: many,
    });
    const experienceInserts = log.filter((s) => /INSERT INTO experience \(/.test(s.sql));
    expect(experienceInserts).toHaveLength(2);
    expect(Math.max(...experienceInserts.map((s) => s.values.length))).toBeLessThan(65535);
    expect(EXPERIENCE_INSERT_BATCH * 15).toBeLessThan(65535);
    expect(LINK_INSERT_BATCH * 3).toBeLessThan(65535);
  });

  it('a missing table (42P01) surfaces unchanged: the apply path fails loud', async () => {
    const db: TxClient = {
      $transaction: (async () => {
        throw new Error('relation "experience" does not exist (42P01)');
      }) as TxClient['$transaction'],
    };
    await expect(
      new PgExperienceWriter(db).replaceAccount({
        accountId: ACCOUNT,
        fusionVersion: 'fusion-v1',
        syncRunId: uid(7, 7),
        claims: [],
      }),
    ).rejects.toThrow('42P01');
  });
});

describe('PgFusionRunStore', () => {
  it('opens a casting_fusion run and finishes it with counts', async () => {
    const created: unknown[] = [];
    const updated: unknown[] = [];
    const db = {
      syncRun: {
        create: async (a: unknown) => {
          created.push(a);
          return { id: 'run-1' };
        },
        findUnique: async () => ({ startedAt: new Date(Date.now() - 1000) }),
        update: async (a: unknown) => {
          updated.push(a);
          return {};
        },
      },
    } as unknown as ConstructorParameters<typeof PgFusionRunStore>[0];
    const store = new PgFusionRunStore(db);
    expect(await store.open({ stage: 'casting_fusion' })).toBe('run-1');
    expect(created[0]).toMatchObject({ data: { source: 'casting_fusion', status: 'running' } });
    await store.finish(
      'run-1',
      'failed',
      { evidenceRows: 10, deleted: 1, deletedOtherVersions: 0, inserted: 2, links: 3 },
      'failed: x',
    );
    expect(updated[0]).toMatchObject({
      where: { id: 'run-1' },
      data: { status: 'failed', totalScanned: 10, created: 2, errored: 1 },
    });
  });
});
