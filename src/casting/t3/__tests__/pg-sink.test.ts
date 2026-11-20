/**
 * The Postgres sink, checked with a fake client: the SQL it builds, what it writes to
 * `sync_runs`, and that a missing `evidence` table (42P01) is refused before anything is
 * written. No database is involved.
 */
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PgT3Sink, isUndefinedTable, type T3DbClient } from '../pg-sink';
import type { EvidenceRowShape } from '../row';
import { SinkUnavailableError } from '../sink';

const RUN_ID = 'b0000000-0000-4000-8000-000000000002';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

const row = (n: number): EvidenceRowShape => ({
  staff_id: n % 2 ? 'a0000000-0000-4000-8000-000000000001' : null,
  raw_name: `Person qa${n} Example`,
  person_kind: n % 2 ? 'staff' : 'external_unresolved',
  account_id: ACCOUNT,
  job_number: null,
  campaign_id: null,
  piece_id: null,
  role_raw: 'Producer',
  role_norm: null,
  seniority: null,
  period_start: n === 1 ? '2025-01-01' : null,
  period_end: n === 1 ? '2025-12-31' : null,
  source: 'drive_content',
  file_id: `f${n}`,
  location: 'slide 2',
  quote: 'Producer: Person',
  confidence: n % 2 ? 0.9 : 0,
  withheld_reason: n % 2 ? null : 'unresolved',
  extractor_version: 't3-v1:gemini-3.5-flash:low',
  claim_hash: `h${n}`,
});

/** A Prisma-shaped raw-query error for a missing table. */
const missingTable = (): Error =>
  Object.assign(
    new Error('Raw query failed. Code: `42P01`. Message: `relation "evidence" does not exist`'),
    {
      code: 'P2010',
      meta: { code: '42P01', message: 'relation "evidence" does not exist' },
    },
  );

function fakeDb(opts: { queryError?: Error; executeError?: Error; affected?: number } = {}) {
  const sql: Prisma.Sql[] = [];
  const syncRun: Array<{ op: string; args: any }> = [];
  const db = {
    $queryRaw: async (q: Prisma.Sql) => {
      sql.push(q);
      if (opts.queryError) throw opts.queryError;
      return [];
    },
    $executeRaw: async (q: Prisma.Sql) => {
      sql.push(q);
      if (opts.executeError) throw opts.executeError;
      return opts.affected ?? 0;
    },
    syncRun: {
      create: async (args: any) => (syncRun.push({ op: 'create', args }), { id: RUN_ID }),
      update: async (args: any) => (syncRun.push({ op: 'update', args }), {}),
    },
  } as unknown as T3DbClient;
  return { db, sql, syncRun };
}

describe('isUndefinedTable', () => {
  it('recognises the Prisma wrapper, a bare pg error and a plain message', () => {
    expect(isUndefinedTable(missingTable())).toBe(true);
    expect(isUndefinedTable({ code: '42P01' })).toBe(true);
    expect(isUndefinedTable(new Error('relation "evidence" does not exist'))).toBe(true);
    expect(isUndefinedTable(new Error('connection reset'))).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
    expect(isUndefinedTable('42P01')).toBe(false);
  });
});

describe('PgT3Sink.startRun', () => {
  it('probes the evidence table first, then opens a running casting_t3 run', async () => {
    const { db, sql, syncRun } = fakeDb();
    const out = await new PgT3Sink(db).startRun({
      extractorVersion: 't3-v1:gemini-3.5-flash:low',
      details: { mode: 'ledger_load', ok_cells: 3 },
    });
    expect(out).toEqual({ syncRunId: RUN_ID });
    expect(sql[0]?.sql).toMatch(/SELECT 1 AS ok FROM evidence LIMIT 0/);
    expect(syncRun[0]?.args.data).toMatchObject({
      source: 'casting_t3',
      status: 'running',
      details: {
        mode: 'ledger_load',
        ok_cells: 3,
        stage: 'casting_t3',
        extractor_version: 't3-v1:gemini-3.5-flash:low',
      },
    });
  });

  it('before the migration (42P01): a clear refusal and NO sync_runs row', async () => {
    const { db, syncRun } = fakeDb({ queryError: missingTable() });
    const err = await new PgT3Sink(db).startRun({ extractorVersion: 'v' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinkUnavailableError);
    expect((err as Error).message).toMatch(/42P01/);
    expect((err as Error).message).toMatch(/UB casting migration/);
    expect((err as Error).message).toMatch(/Nothing was written/);
    expect(syncRun).toHaveLength(0);
  });

  it('any other probe error is not disguised and also creates no run', async () => {
    const { db, syncRun } = fakeDb({ queryError: new Error('connection reset') });
    await expect(new PgT3Sink(db).startRun({ extractorVersion: 'v' })).rejects.toThrow(
      'connection reset',
    );
    expect(syncRun).toHaveLength(0);
  });
});

describe('PgT3Sink.writeEvidence', () => {
  it('inserts append-only with the idempotency key and reports inserted vs already present', async () => {
    const { db, sql } = fakeDb({ affected: 2 });
    const sink = new PgT3Sink(db);
    const { syncRunId } = await sink.startRun({ extractorVersion: 'v' });
    const out = await sink.writeEvidence(syncRunId, [row(1), row(2), row(3)]);
    expect(out).toEqual({ inserted: 2, duplicates: 1 });
    const insert = sql.find((q) => /INSERT INTO evidence/.test(q.sql))!;
    expect(insert.sql).toMatch(/ON CONFLICT \(extractor_version, claim_hash\) DO NOTHING/);
    expect(insert.sql).not.toMatch(/UPDATE|DELETE/);
    expect(insert.values).toHaveLength(3 * 22);
    expect(insert.values).toContain('h1');
    expect(insert.values).toContain(RUN_ID);
    expect(insert.values).toContain('drive_content');
    expect(insert.values).toContain('2025-01-01');
    expect(insert.values).toContain('t3-v1:gemini-3.5-flash:low');
  });

  it('an empty batch writes nothing', async () => {
    const { db, sql } = fakeDb();
    const sink = new PgT3Sink(db);
    const { syncRunId } = await sink.startRun({ extractorVersion: 'v' });
    expect(await sink.writeEvidence(syncRunId, [])).toEqual({ inserted: 0, duplicates: 0 });
    expect(sql.filter((q) => /INSERT/.test(q.sql))).toHaveLength(0);
  });

  it('a run this sink did not start is refused', async () => {
    const { db } = fakeDb();
    await expect(new PgT3Sink(db).writeEvidence('nope', [row(1)])).rejects.toThrow(/not started/);
  });

  it('a table that vanishes mid-run is the same clear refusal', async () => {
    const { db } = fakeDb({ executeError: missingTable() });
    const sink = new PgT3Sink(db);
    const { syncRunId } = await sink.startRun({ extractorVersion: 'v' });
    await expect(sink.writeEvidence(syncRunId, [row(1)])).rejects.toBeInstanceOf(
      SinkUnavailableError,
    );
  });
});

describe('PgT3Sink.finishRun', () => {
  it('closes the run with the counters of what it wrote', async () => {
    const { db, syncRun } = fakeDb({ affected: 2 });
    const sink = new PgT3Sink(db);
    const { syncRunId } = await sink.startRun({
      extractorVersion: 'v',
      details: { mode: 'ledger_load' },
    });
    await sink.writeEvidence(syncRunId, [row(1), row(2), row(3)]);
    await sink.finishRun(syncRunId, {
      status: 'success',
      summary: { cells: 3, rows: 2, costUsd: 0 },
      details: { rows_inserted: 2 },
    });
    const upd = syncRun.find((c) => c.op === 'update')!.args;
    expect(upd.where).toEqual({ id: RUN_ID });
    expect(upd.data).toMatchObject({
      status: 'success',
      totalScanned: 3,
      created: 2,
      skipped: 1,
      details: { mode: 'ledger_load', rows_inserted: 2, outcome: 'success', stage: 'casting_t3' },
    });
    expect(upd.data.completedAt).toBeInstanceOf(Date);
    expect(upd.data.summary).toMatch(/^casting_t3: success/);
  });

  it('a failed or stopped run is recorded failed with the reason in details', async () => {
    const { db, syncRun } = fakeDb();
    const sink = new PgT3Sink(db);
    const { syncRunId } = await sink.startRun({ extractorVersion: 'v' });
    await sink.finishRun(syncRunId, {
      status: 'stopped',
      summary: { cells: 0, rows: 0, costUsd: 0 },
    });
    const upd = syncRun.find((c) => c.op === 'update')!.args.data;
    expect(upd.status).toBe('failed');
    expect(upd.details.outcome).toBe('stopped');
  });
});
