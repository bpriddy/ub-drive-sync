import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { probeChanges, type ProbeClient } from '../change-probe';

const ACCT = '11111111-1111-4111-8111-111111111111';

/** Captures the SQL; no database is involved. */
function fakeDb(answers: unknown[]) {
  const calls: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (sql: Prisma.Sql) => {
      calls.push(sql);
      return answers.shift() ?? [];
    },
  } as unknown as ProbeClient;
  return { db, calls };
}

describe('probeChanges', () => {
  it('no baseline run: changed, and the file index is not queried', async () => {
    const { db, calls } = fakeDb([[{ baseline: null }]]);
    expect(await probeChanges(db, ACCT)).toEqual({
      changed: true,
      reason: 'no_baseline',
      filesChanged: null,
    });
    expect(calls).toHaveLength(1);
  });

  it('a baseline and no newer row: not changed', async () => {
    const { db } = fakeDb([[{ baseline: new Date('2026-11-20T00:00:00Z') }], [{ n: 0n }]]);
    expect(await probeChanges(db, ACCT)).toEqual({
      changed: false,
      reason: 'no_change',
      filesChanged: 0,
    });
  });

  it('newer rows: changed, with the distinct file count', async () => {
    const { db } = fakeDb([[{ baseline: new Date('2026-11-20T00:00:00Z') }], [{ n: 7n }]]);
    expect(await probeChanges(db, ACCT)).toEqual({
      changed: true,
      reason: 'changed',
      filesChanged: 7,
    });
  });

  it('reads only: the baseline is a successful casting_t1 run of the account, the index query skips "unchanged" rows', async () => {
    const { db, calls } = fakeDb([[{ baseline: new Date('2026-11-20T00:00:00Z') }], [{ n: 1 }]]);
    await probeChanges(db, ACCT);
    const [baseline, index] = calls as [Prisma.Sql, Prisma.Sql];
    expect(baseline.sql).toMatch(/source = 'casting_t1'/);
    expect(baseline.sql).toMatch(/status = 'success'/);
    expect(baseline.sql).toMatch(/account_ids/);
    expect(baseline.values).toContain(ACCT);
    expect(index.sql).toMatch(/count\(DISTINCT file_id\)/);
    expect(index.sql).toMatch(/scanned_at >/);
    expect(index.values).toEqual(
      expect.arrayContaining([ACCT, 'delta_unchanged', 'content_unchanged', 'trashed']),
    );
    for (const sql of calls) expect(sql.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
