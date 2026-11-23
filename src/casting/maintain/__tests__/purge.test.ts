import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  PURGE_BATCH,
  PURGE_EXIT,
  PURGE_SYNC_SOURCE,
  parsePurgeArgs,
  runPurge,
  type PurgeCount,
  type PurgeStore,
} from '../purge';
import { PgPurgeStore, type PurgeClient } from '../purge-pg';

const ACCT = '11111111-1111-4111-8111-111111111111';
const V = 't3-v1:gemini-3.5-flash:low';
const argv = (...extra: string[]) => ['--account-id', ACCT, '--extractor-version', V, ...extra];

describe('parsePurgeArgs', () => {
  it('dry-run by default; --apply needs --expect-rows; --expect-rows needs --apply', () => {
    expect(parsePurgeArgs(argv())).toMatchObject({ apply: false, expectRows: null });
    expect(() => parsePurgeArgs(argv('--apply'))).toThrow(/--expect-rows/);
    expect(() => parsePurgeArgs(argv('--expect-rows', '5'))).toThrow(
      /only means something with --apply/,
    );
    expect(parsePurgeArgs(argv('--apply', '--expect-rows', '5'))).toMatchObject({
      apply: true,
      expectRows: 5,
    });
  });
  it('one exact stage version and one account; unknown flags are errors', () => {
    expect(() => parsePurgeArgs(['--extractor-version', V])).toThrow(/account-id/);
    expect(() => parsePurgeArgs(['--account-id', ACCT])).toThrow(/extractor-version/);
    expect(() => parsePurgeArgs(['--account-id', ACCT, '--extractor-version', '%'])).toThrow(
      /exact stage version/,
    );
    expect(() =>
      parsePurgeArgs(['--account-id', ACCT, '--extractor-version', 'fusion-v2']),
    ).toThrow(/exact stage version/);
    expect(() => parsePurgeArgs(argv('--all-accounts'))).toThrow(/unknown argument/);
  });
});

function memoryStore(rows: number, over: Partial<PurgeStore> = {}) {
  const log: string[] = [];
  let left = rows;
  const count: PurgeCount = {
    rows,
    syncRuns: 2,
    bySyncRun: [
      { syncRunId: 'run-a', rows: rows - 1 },
      { syncRunId: 'run-b', rows: 1 },
    ],
  };
  const store: PurgeStore = {
    count: async () => ({ ...count, rows: left }),
    startRun: async (d) => (log.push(`start ${JSON.stringify(d)}`), 'purge-run'),
    deleteBatch: async (_a, _v, limit) => {
      const n = Math.min(limit, left);
      left -= n;
      log.push(`delete ${n}`);
      return n;
    },
    finishRun: async (id, status, deleted) => void log.push(`finish ${id} ${status} ${deleted}`),
    ...over,
  };
  return { store, log };
}

describe('runPurge', () => {
  it('dry-run counts, tags by sync run, deletes nothing, opens no run', async () => {
    const { store, log } = memoryStore(7);
    const out: string[] = [];
    expect(await runPurge(parsePurgeArgs(argv()), store, (l) => out.push(l))).toBe(
      PURGE_EXIT.dryRun,
    );
    expect(log).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('rows of this version for the account: 7');
    expect(text).toContain('sync run run-a');
    expect(text).toContain('--apply --expect-rows 7');
  });

  it('apply with the matching count deletes in batches under a recorded sync run', async () => {
    const n = PURGE_BATCH + 10;
    const { store, log } = memoryStore(n);
    const out: string[] = [];
    expect(
      await runPurge(parsePurgeArgs(argv('--apply', '--expect-rows', String(n))), store, (l) =>
        out.push(l),
      ),
    ).toBe(PURGE_EXIT.ok);
    expect(log[0]).toMatch(/^start .*"stage":"casting_purge".*"rows_expected":/);
    expect(log.slice(1)).toEqual([
      `delete ${PURGE_BATCH}`,
      'delete 10',
      `finish purge-run success ${n}`,
    ]);
    expect(out.join('\n')).toContain('rebuild Layer 2');
  });

  it('a different count than the one confirmed refuses and deletes nothing', async () => {
    const { store, log } = memoryStore(7);
    expect(
      await runPurge(parsePurgeArgs(argv('--apply', '--expect-rows', '9')), store, () => undefined),
    ).toBe(PURGE_EXIT.refused);
    expect(log).toEqual([]);
  });

  it('nothing to purge is not an error and opens no run', async () => {
    const { store, log } = memoryStore(0);
    expect(
      await runPurge(parsePurgeArgs(argv('--apply', '--expect-rows', '3')), store, () => undefined),
    ).toBe(PURGE_EXIT.ok);
    expect(log).toEqual([]);
  });

  it('a failing delete marks the run failed with the rows deleted so far and rethrows', async () => {
    const { store, log } = memoryStore(3, {
      deleteBatch: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      runPurge(parsePurgeArgs(argv('--apply', '--expect-rows', '3')), store, () => undefined),
    ).rejects.toThrow('boom');
    expect(log.some((l) => l.startsWith('finish purge-run failed 0'))).toBe(true);
  });
});

describe('PgPurgeStore: the SQL is scoped to one account and one version', () => {
  it('count, delete and the run row', async () => {
    const queries: Prisma.Sql[] = [];
    const creates: unknown[] = [];
    const db = {
      $queryRaw: async (s: Prisma.Sql) => (
        queries.push(s),
        [
          { sync_run_id: 'r1', n: 4 },
          { sync_run_id: 'r2', n: 1 },
        ]
      ),
      $executeRaw: async (s: Prisma.Sql) => (queries.push(s), 5),
      syncRun: {
        create: async (a: unknown) => (creates.push(a), { id: 'new-run' }),
        update: async () => ({}),
      },
    } as unknown as PurgeClient;
    const store = new PgPurgeStore(db);
    expect(await store.count(ACCT, V)).toEqual({
      rows: 5,
      syncRuns: 2,
      bySyncRun: [
        { syncRunId: 'r1', rows: 4 },
        { syncRunId: 'r2', rows: 1 },
      ],
    });
    expect(await store.deleteBatch(ACCT, V, 100)).toBe(5);
    expect(await store.startRun({ a: 1 })).toBe('new-run');
    const [count, del] = queries as [Prisma.Sql, Prisma.Sql];
    expect(count.sql).toMatch(/account_id = .*extractor_version = /s);
    expect(count.values).toEqual([ACCT, V]);
    expect(del.sql).toMatch(/^\s*DELETE FROM evidence/);
    expect(del.sql).toMatch(/account_id = .*AND extractor_version = .*LIMIT/s);
    expect(del.values).toEqual([ACCT, V, 100]);
    expect(creates[0]).toMatchObject({ data: { source: PURGE_SYNC_SOURCE, status: 'running' } });
  });
});
