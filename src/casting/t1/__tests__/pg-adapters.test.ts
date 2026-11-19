import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  PgCatalogReader,
  PgEvidenceWriter,
  PgIndexReader,
  PgRunStore,
  loadRoster,
  type RawClient,
} from '../pg-adapters';
import type { EvidenceInsertRow } from '../types';
import { ACCOUNT } from './fixtures';

/** Captures the SQL the adapters build; no database is involved. */
function fakeDb(answers: unknown[] = [], affected = 0) {
  const calls: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (sql: Prisma.Sql) => {
      calls.push(sql);
      return answers.shift() ?? [];
    },
    $executeRaw: async (sql: Prisma.Sql) => {
      calls.push(sql);
      return affected;
    },
  } as unknown as RawClient;
  return { db, calls };
}

const row = (n: number): EvidenceInsertRow => ({
  staffId: n % 2 ? 'a0000000-0000-4000-8000-000000000001' : null,
  rawName: `u${n}@agency.example`,
  personKind: n % 2 ? 'staff' : 'external_unresolved',
  accountId: ACCOUNT,
  jobNumber: null,
  campaignId: null,
  pieceId: null,
  roleRaw: null,
  roleNorm: null,
  seniority: null,
  periodStart: null,
  periodEnd: null,
  source: 'drive_metadata',
  fileId: `f${n}`,
  location: null,
  quote: null,
  confidence: 0.3,
  withheldReason: n % 2 ? null : 'unresolved',
  extractorVersion: 't1-metadata-v1',
  syncRunId: 'b0000000-0000-4000-8000-000000000002',
  claimHash: `h${n}`,
});

describe('PgIndexReader', () => {
  it('reads the latest row per file, keyset-paged, without touching created_time', async () => {
    const { db, calls } = fakeDb([[{ fileId: 'f1' }]]);
    const out = await new PgIndexReader(db).readPage(ACCOUNT, 'f0', 500);
    expect(out).toEqual([{ fileId: 'f1' }]);
    const sql = calls[0]!;
    expect(sql.sql).toMatch(/DISTINCT ON \(file_id\)/);
    expect(sql.sql).toMatch(/ORDER BY file_id, scanned_at DESC/);
    expect(sql.sql).toMatch(/file_id > /);
    expect(sql.sql).not.toMatch(/created_time/);
    expect(sql.sql).not.toMatch(/SELECT \*/);
    expect(sql.values).toEqual([ACCOUNT, 'f0', 500]);
  });

  it('starts from the beginning with an empty cursor', async () => {
    const { db, calls } = fakeDb();
    await new PgIndexReader(db).readPage(ACCOUNT, null, 10);
    expect(calls[0]!.values).toEqual([ACCOUNT, '', 10]);
  });
});

describe('PgCatalogReader', () => {
  it('maps dates to ISO days and scopes both reads to the account', async () => {
    const { db, calls } = fakeDb([
      [{ id: 'c1', awardedAt: new Date('2024-02-01T00:00:00Z'), liveAt: null, endsAt: null }],
      [{ id: 'p1', campaignId: 'c1', jobNumber: 'ACME55000216' }],
    ]);
    const catalog = await new PgCatalogReader(db).load(ACCOUNT);
    expect(catalog.campaigns).toEqual([
      { id: 'c1', awardedAt: '2024-02-01', liveAt: null, endsAt: null },
    ]);
    expect(catalog.pieces).toEqual([{ id: 'p1', campaignId: 'c1', jobNumber: 'ACME55000216' }]);
    expect(calls.every((c) => c.values.includes(ACCOUNT))).toBe(true);
  });
});

describe('loadRoster', () => {
  it('maps staff rows to roster entries', async () => {
    const { db } = fakeDb([
      [
        {
          id: 's1',
          fullName: 'A B',
          email: 'a@x.example',
          startedAt: new Date('2020-01-02T00:00:00Z'),
          endedAt: null,
          status: 'on_leave',
          isPerson: true,
        },
        {
          id: 's2',
          fullName: 'C D',
          email: null,
          startedAt: new Date('2019-05-06T00:00:00Z'),
          endedAt: new Date('2022-01-01T00:00:00Z'),
          status: 'former',
          isPerson: true,
        },
      ],
    ]);
    expect(await loadRoster(db)).toEqual([
      {
        staffId: 's1',
        fullName: 'A B',
        email: 'a@x.example',
        startedAt: '2020-01-02',
        endedAt: null,
        isActive: true,
        isPerson: true,
      },
      {
        staffId: 's2',
        fullName: 'C D',
        email: null,
        startedAt: '2019-05-06',
        endedAt: '2022-01-01',
        isActive: false,
        isPerson: true,
      },
    ]);
  });
});

describe('PgEvidenceWriter', () => {
  it('inserts append-only with the idempotency key and reports what was really inserted', async () => {
    const { db, calls } = fakeDb([], 2);
    const out = await new PgEvidenceWriter(db).insertBatch([row(1), row(2), row(3)]);
    expect(out).toEqual({ inserted: 2 });
    const sql = calls[0]!;
    expect(sql.sql).toMatch(/INSERT INTO evidence/);
    expect(sql.sql).toMatch(/ON CONFLICT \(extractor_version, claim_hash\) DO NOTHING/);
    expect(sql.sql).not.toMatch(/UPDATE|DELETE/);
    expect(sql.values).toHaveLength(3 * 22);
    expect(sql.values).toContain('h1');
  });

  it('does nothing for an empty batch', async () => {
    const { db, calls } = fakeDb();
    expect(await new PgEvidenceWriter(db).insertBatch([])).toEqual({ inserted: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('PgRunStore', () => {
  function fakeSyncRun(stored: Record<string, unknown> | null) {
    const calls: Array<{ op: string; args: any }> = [];
    const db = {
      syncRun: {
        create: async (args: any) => (calls.push({ op: 'create', args }), { id: 'run-1' }),
        update: async (args: any) => (calls.push({ op: 'update', args }), {}),
        findUnique: async (args: any) => (calls.push({ op: 'find', args }), stored),
      },
    } as any;
    return { db, calls };
  }
  const counters = { filesSeen: 5, rowsInserted: 3, rowsDuplicate: 1, rowsFailed: 0 };

  it('opens a running casting_t1 run and saves the checkpoint with the counters', async () => {
    const { db, calls } = fakeSyncRun(null);
    const store = new PgRunStore(db);
    const id = await store.open({ window_start: '2021-11-19' });
    expect(id).toBe('run-1');
    expect(calls[0]!.args.data).toMatchObject({ source: 'casting_t1', status: 'running' });
    await store.saveProgress(
      id,
      { accountId: ACCOUNT, afterFileId: 'f9', doneAccountIds: [] },
      counters,
    );
    const upd = calls[1]!.args.data;
    expect(upd.details).toMatchObject({
      window_start: '2021-11-19',
      checkpoint: { afterFileId: 'f9' },
    });
    expect(upd).toMatchObject({ totalScanned: 5, created: 3, skipped: 1, errored: 0 });
  });

  it('refuses to resume a foreign or finished run, and returns the saved checkpoint otherwise', async () => {
    await expect(
      new PgRunStore(
        fakeSyncRun({ source: 'google_drive', status: 'failed', details: {} }).db,
      ).loadCheckpoint('r'),
    ).rejects.toThrow(/not a casting/);
    await expect(
      new PgRunStore(
        fakeSyncRun({ source: 'casting_t1', status: 'success', details: {} }).db,
      ).loadCheckpoint('r'),
    ).rejects.toThrow(/finished/);
    const cp = { accountId: ACCOUNT, afterFileId: 'f9', doneAccountIds: [] };
    const { db } = fakeSyncRun({
      source: 'casting_t1',
      status: 'paused',
      details: { checkpoint: cp },
    });
    expect(await new PgRunStore(db).loadCheckpoint('r')).toEqual(cp);
  });

  it('a paused run stays open (no completedAt), a finished one is closed', async () => {
    const { db, calls } = fakeSyncRun({ startedAt: new Date(Date.now() - 1000) });
    const store = new PgRunStore(db);
    await store.finish('r', 'paused', counters, 'paused');
    await store.finish('r', 'success', counters, 'ok');
    const updates = calls.filter((c) => c.op === 'update').map((c) => c.args.data);
    expect(updates[0].completedAt).toBeNull();
    expect(updates[1].completedAt).toBeInstanceOf(Date);
    expect(updates[1].status).toBe('success');
  });
});
