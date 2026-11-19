import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { RawClient } from '../../../t1/pg-adapters';
import { parseBackfillArgs } from '../args';
import { PgAccountReader, PgBackfillRunStore, PgExistingStatsReader } from '../pg-adapters';
import { ACCOUNT } from './fixtures';

const base = ['--account-id', ACCOUNT, '--from', '2025-01-01', '--to', '2025-03-01'];

describe('parseBackfillArgs', () => {
  it('defaults to a dry-run with 30-day windows', () => {
    expect(parseBackfillArgs(base)).toMatchObject({
      accountId: ACCOUNT,
      from: '2025-01-01',
      to: '2025-03-01',
      windowDays: 30,
      confirm: false,
      resumeRunId: null,
      budgetSeconds: null,
      maxCalls: null,
    });
  });
  it('parses every flag', () => {
    expect(
      parseBackfillArgs([
        ...base,
        '--confirm',
        '--window-days=7',
        '--budget-seconds',
        '120',
        '--max-calls',
        '50',
        '--existing-window-days',
        '7',
        '--resume-run-id',
        ACCOUNT,
      ]),
    ).toMatchObject({
      confirm: true,
      windowDays: 7,
      budgetSeconds: 120,
      maxCalls: 50,
      existingWindowDays: 7,
      resumeRunId: ACCOUNT,
    });
  });
  it('is strict', () => {
    expect(() => parseBackfillArgs([...base, '--confrim'])).toThrow(/unknown argument/);
    expect(() => parseBackfillArgs(['--account-id', ACCOUNT, '--from', '2025-01-01'])).toThrow(
      /--to is required/,
    );
    expect(() => parseBackfillArgs(base.slice(2))).toThrow(/--account-id is required/);
    expect(() => parseBackfillArgs([...base, '--account-id', ACCOUNT])).toThrow(/exactly one/);
    expect(() => parseBackfillArgs([...base, '--window-days', '31'])).toThrow(/1 to 30/);
    expect(() => parseBackfillArgs([...base, '--max-calls', '0'])).toThrow(/positive integer/);
    expect(() => parseBackfillArgs([...base, '--budget-seconds', '-1'])).toThrow(/positive/);
    expect(() =>
      parseBackfillArgs(['--account-id', ACCOUNT, '--from', '2025-03-01', '--to', '2025-01-01']),
    ).toThrow(/earlier/);
    expect(() =>
      parseBackfillArgs(['--account-id', ACCOUNT, '--from', '2025-02-30', '--to', '2025-03-01']),
    ).toThrow(/YYYY-MM-DD/);
    expect(() => parseBackfillArgs([...base, '--resume-run-id', ACCOUNT])).toThrow(/--confirm/);
    expect(() => parseBackfillArgs([...base, '--from'])).toThrow(/needs a value/);
  });
});

function fakeDb(answers: unknown[] = []) {
  const calls: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (sql: Prisma.Sql) => {
      calls.push(sql);
      return answers.shift() ?? [];
    },
    $executeRaw: async () => 0,
  } as unknown as RawClient;
  return { db, calls };
}

describe('pg adapters', () => {
  it('existing runs: one row per run id of the account, read-only', async () => {
    const { db, calls } = fakeDb([
      [{ syncRunId: 'r', minDay: '2025-01-01', maxDay: '2025-01-01', rows: 2 }],
    ]);
    const out = await new PgExistingStatsReader(db).runs(ACCOUNT);
    expect(out).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/FROM drive_edit_stats/);
    expect(calls[0]!.sql).toMatch(/GROUP BY sync_run_id/);
    expect(calls[0]!.sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
    expect(calls[0]!.values).toEqual([ACCOUNT]);
  });

  it('drive root: null when missing', async () => {
    const { db, calls } = fakeDb([[{ driveFolderId: 'root' }], []]);
    const r = new PgAccountReader(db);
    expect(await r.driveRoot(ACCOUNT)).toBe('root');
    expect(await r.driveRoot(ACCOUNT)).toBeNull();
    expect(calls[0]!.sql).toMatch(/FROM accounts/);
  });

  it('run store: source, checkpoint round trip, refuses other sources and finished runs', async () => {
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
    const runs = new PgBackfillRunStore(db as never);
    const id = await runs.open({ from: '2025-01-01' });
    expect(store.get(id)).toMatchObject({
      source: 'drive_edit_stats_backfill',
      details: { stage: 'edit_stats_backfill', from: '2025-01-01' },
    });
    const cp = { accountId: ACCOUNT, nextWindow: 3 };
    await runs.saveProgress(id, cp, { windowsDone: 3, events: 9, calls: 3, statRows: 12 });
    expect(store.get(id)).toMatchObject({ totalScanned: 3, created: 12 });
    expect(await new PgBackfillRunStore(db as never).loadCheckpoint(id)).toEqual(cp);
    store.set(id, { ...store.get(id), source: 'casting_t2' });
    await expect(runs.loadCheckpoint(id)).rejects.toThrow(/not an edit-stats backfill/);
    store.set(id, { ...store.get(id), source: 'drive_edit_stats_backfill', status: 'success' });
    await expect(runs.loadCheckpoint(id)).rejects.toThrow(/already finished/);
    await runs.finish(id, 'paused', { windowsDone: 1, events: 0, calls: 0, statRows: 0 }, 's');
    expect(store.get(id)).toMatchObject({ status: 'paused', completedAt: null });
  });
});
