import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { RawClient } from '../../t1/pg-adapters';
import { PgFileIndexLookup, PgPeopleMapReader, PgStatsReader, PgT2RunStore } from '../pg-adapters';
import { ACCOUNT } from './fixtures';

function fakeDb(answers: unknown[] = []) {
  const calls: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (sql: Prisma.Sql) => {
      calls.push(sql);
      return answers.shift() ?? [];
    },
    $executeRaw: async (sql: Prisma.Sql) => {
      calls.push(sql);
      return 0;
    },
  } as unknown as RawClient;
  return { db, calls };
}

describe('PgStatsReader', () => {
  it('range reads min and max day of one account, null when empty', async () => {
    const { db, calls } = fakeDb([
      [{ minDay: '2025-03-05', maxDay: '2026-11-03' }],
      [{ minDay: null, maxDay: null }],
    ]);
    const r = new PgStatsReader(db);
    expect(await r.range(ACCOUNT)).toEqual({ minDay: '2025-03-05', maxDay: '2026-11-03' });
    expect(calls[0]!.sql).toMatch(/FROM drive_edit_stats/);
    expect(calls[0]!.values).toEqual([ACCOUNT]);
    expect(await r.range(ACCOUNT)).toBeNull();
  });

  it('reads one month as (file, actor) groups, keyset-paged, from the first page', async () => {
    const { db, calls } = fakeDb([[]]);
    await new PgStatsReader(db).readPage(ACCOUNT, '2025-12', null, 500);
    const q = calls[0]!;
    expect(q.sql).toMatch(/FROM drive_edit_stats/);
    expect(q.sql).toMatch(/GROUP BY file_id, actor_email/);
    expect(q.sql).toMatch(/\(file_id, actor_email\) > \(/);
    expect(q.sql).toMatch(/ORDER BY file_id, actor_email/);
    expect(q.sql).not.toMatch(/created_time|evidence/);
    expect(q.values).toEqual([ACCOUNT, '2025-12-01', '2026-01-01', '', '', 500]);
  });

  it('continues after a cursor', async () => {
    const { db, calls } = fakeDb([[]]);
    await new PgStatsReader(db).readPage(ACCOUNT, '2025-03', { fileId: 'f9', actor: 'a' }, 10);
    expect(calls[0]!.values).toEqual([ACCOUNT, '2025-03-01', '2025-04-01', 'f9', 'a', 10]);
  });
});

describe('PgFileIndexLookup', () => {
  it('reads the latest row per file for the ids and maps by id; no query for no ids', async () => {
    const { db, calls } = fakeDb([[{ fileId: 'f1', name: 'n' }]]);
    const l = new PgFileIndexLookup(db);
    expect((await l.lookup(ACCOUNT, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
    const out = await l.lookup(ACCOUNT, ['f1', 'f2']);
    expect([...out.keys()]).toEqual(['f1']);
    expect(calls[0]!.sql).toMatch(/DISTINCT ON \(file_id\)/);
    expect(calls[0]!.sql).toMatch(/= ANY\(/);
    expect(calls[0]!.sql).not.toMatch(/created_time/);
    expect(calls[0]!.values).toEqual([ACCOUNT, ['f1', 'f2']]);
  });
});

describe('PgPeopleMapReader', () => {
  it('reads the cache table only', async () => {
    const { db, calls } = fakeDb([
      [
        { resource: 'people/1', email: 'a@b.example' },
        { resource: 'people/2', email: null },
      ],
    ]);
    const out = await new PgPeopleMapReader(db).lookup(['people/1', 'people/2', 'people/3']);
    expect(out.get('people/1')).toBe('a@b.example');
    expect(out.get('people/2')).toBeNull();
    expect(out.has('people/3')).toBe(false);
    expect(calls[0]!.sql).toMatch(/FROM people_resource_map/);
    expect(calls[0]!.sql).not.toMatch(/INSERT|UPDATE/i);
  });
});

describe('PgT2RunStore', () => {
  function fakeSyncRun() {
    const store = new Map<string, Record<string, unknown>>();
    const db = {
      syncRun: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          store.set('r1', { ...data, startedAt: new Date() });
          return { id: 'r1' };
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          store.set(where.id, { ...store.get(where.id), ...data });
        },
        findUnique: async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null,
      },
    };
    return { db, store };
  }

  it('opens with source casting_t2 and a stage-stamped details object', async () => {
    const { db, store } = fakeSyncRun();
    const id = await new PgT2RunStore(db as never).open({ window_start: '2021-11-19' });
    expect(store.get(id)).toMatchObject({
      source: 'casting_t2',
      status: 'running',
      details: {
        stage: 'casting_t2',
        extractor_version: 't2-activity-v1',
        window_start: '2021-11-19',
      },
    });
  });

  it('round-trips a checkpoint and refuses runs of another stage or finished runs', async () => {
    const { db, store } = fakeSyncRun();
    const runs = new PgT2RunStore(db as never);
    const id = await runs.open({});
    const cp = {
      accountId: ACCOUNT,
      month: '2025-03',
      after: { fileId: 'f1', actor: 'a' },
      doneAccountIds: [],
    };
    await runs.saveProgress(id, cp, {
      filesSeen: 3,
      rowsInserted: 2,
      rowsDuplicate: 1,
      rowsFailed: 0,
    });
    expect(store.get(id)).toMatchObject({ totalScanned: 3, created: 2, skipped: 1, errored: 0 });
    expect(await new PgT2RunStore(db as never).loadCheckpoint(id)).toEqual(cp);

    store.set(id, { ...store.get(id), source: 'casting_t1' });
    await expect(runs.loadCheckpoint(id)).rejects.toThrow(/not a casting T2 run/);
    store.set(id, { ...store.get(id), source: 'casting_t2', status: 'success' });
    await expect(runs.loadCheckpoint(id)).rejects.toThrow(/already finished/);
    await expect(runs.loadCheckpoint('missing')).rejects.toThrow(/not found/);
  });

  it('finish stamps the status; a paused run keeps completedAt open', async () => {
    const { db, store } = fakeSyncRun();
    const runs = new PgT2RunStore(db as never);
    const id = await runs.open({});
    const c = { filesSeen: 1, rowsInserted: 1, rowsDuplicate: 0, rowsFailed: 0 };
    await runs.finish(id, 'paused', c, 's');
    expect(store.get(id)).toMatchObject({ status: 'paused', completedAt: null });
    await runs.finish(id, 'success', c, 's');
    expect((store.get(id) as { completedAt: Date }).completedAt).toBeInstanceOf(Date);
  });
});
