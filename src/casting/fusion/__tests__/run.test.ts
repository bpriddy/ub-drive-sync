import { describe, expect, it } from 'vitest';
import { runFusion } from '../run';
import type {
  ActivityHorizon,
  CatalogLoader,
  EvidenceReader,
  FusionEvidence,
  FusionRunStore,
  RunCounts,
  StaffLoader,
  StaffWorkRollup,
  StaffWorkWriter,
} from '../types';
import {
  ACCOUNT,
  OTHER_ACCOUNT,
  TODAY,
  accounts,
  campaigns,
  ev,
  generateInput,
  pieces,
  resetIds,
  staff,
} from './fixtures';

const T = new Date(`${TODAY}T10:00:00Z`);

function ports(rows: FusionEvidence[]) {
  const reads: Array<{ accountId: string; after: string | null; limit: number }> = [];
  const evidence: EvidenceReader = {
    async readPage(accountId, after, limit) {
      reads.push({ accountId, after, limit });
      const own = rows
        .filter((r) => r.accountId === accountId)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const start = after === null ? 0 : own.findIndex((r) => r.id === after) + 1;
      return own.slice(start, start + limit);
    },
  };
  const catalog: CatalogLoader = {
    async load(accountId) {
      return {
        account: accounts().find((a) => a.id === accountId) ?? null,
        campaigns: campaigns().filter((c) => c.accountId === accountId),
        pieces: pieces(),
      };
    },
  };
  const staffLoader: StaffLoader & { seen: string[] } = {
    seen: [],
    async load(today) {
      this.seen.push(today);
      return staff();
    },
  };
  const activity: ActivityHorizon = { startOf: async () => '2025-11-01' };
  return { reads, evidence, catalog, staff: staffLoader, activity };
}

function sinks() {
  const calls: string[] = [];
  const written: Array<{
    accountId: string;
    buildVersion: string;
    syncRunId: string;
    rollup: StaffWorkRollup;
  }> = [];
  const writer: StaffWorkWriter = {
    async replaceAccount(args) {
      calls.push(`write:${args.accountId}`);
      written.push(args);
      const { accounts, campaigns } = args.rollup;
      return {
        deletedAccounts: 1,
        deletedCampaigns: 2,
        insertedAccounts: accounts.length,
        insertedCampaigns: campaigns.length,
        links: [...accounts, ...campaigns].reduce((n, r) => n + r.evidenceIds.length, 0),
      };
    },
  };
  const finished: Array<{ status: string; counts: RunCounts; summary: string }> = [];
  const runs: FusionRunStore = {
    async open(details) {
      calls.push('open');
      expect(details).toMatchObject({ stage: 'casting_fusion', fusion_version: 'fusion-v4' });
      return 'b0000000-0000-4000-8000-000000000002';
    },
    async finish(_id, status, counts, summary) {
      calls.push(`finish:${status}`);
      finished.push({ status, counts, summary });
    },
  };
  return { calls, written, writer, runs, finished };
}

const sample = (): FusionEvidence[] => {
  resetIds();
  return [
    ev({
      source: 'drive_content',
      roleNorm: 'copywriter',
      confidence: 0.9,
      pieceId: pieces()[0]!.id,
    }),
    ev({ source: 'drive_metadata', confidence: 0.3, pieceId: pieces()[0]!.id }),
    ev({
      source: 'drive_content',
      accountId: OTHER_ACCOUNT,
      roleNorm: 'copywriter',
      confidence: 0.9,
    }),
  ];
};

describe('runFusion', () => {
  it('dry-run is the default: reads, fuses, writes nothing, opens no sync run', async () => {
    const p = ports(sample());
    const s = sinks();
    const report = await runFusion(
      { evidence: p.evidence, catalog: p.catalog, staff: p.staff, activity: p.activity },
      { accountIds: [ACCOUNT, OTHER_ACCOUNT], apply: false, today: T },
    );
    expect(report).toMatchObject({
      mode: 'dry-run',
      fusionVersion: 'fusion-v4',
      today: TODAY,
      runId: null,
      status: 'success',
    });
    expect(report.accounts.map((a) => a.accountId)).toEqual([ACCOUNT, OTHER_ACCOUNT].sort());
    expect(report.accounts.every((a) => a.written === null)).toBe(true);
    // the rollup still runs in dry-run, so the report says what apply would write
    const mine = report.accounts.find((a) => a.accountId === ACCOUNT)!;
    expect(mine.rows).toEqual({ accounts: 1, accountsServed: 1, campaigns: 1, campaignsServed: 1 });
    expect(s.calls).toEqual([]);
    expect(p.staff.seen).toEqual([TODAY]); // the only clock is the injected one
  });

  it('dry-run twice gives the same report', async () => {
    const rows = sample();
    const a = await runFusion(
      { ...ports(rows) },
      { accountIds: [ACCOUNT], apply: false, today: T },
    );
    const b = await runFusion(
      { ...ports(rows) },
      { accountIds: [ACCOUNT], apply: false, today: T },
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('apply opens a run, replaces each account in sorted order, finishes with counts', async () => {
    const p = ports(sample());
    const s = sinks();
    const report = await runFusion(
      { evidence: p.evidence, catalog: p.catalog, staff: p.staff, writer: s.writer, runs: s.runs },
      { accountIds: [OTHER_ACCOUNT, ACCOUNT], apply: true, today: T },
    );
    expect(s.calls).toEqual([
      'open',
      ...[ACCOUNT, OTHER_ACCOUNT].sort().map((a) => `write:${a}`),
      'finish:success',
    ]);
    expect(
      s.written.every((w) => w.buildVersion === 'fusion-v4' && w.syncRunId === report.runId),
    ).toBe(true);
    expect(s.finished[0]?.counts).toMatchObject({
      evidenceRows: 3,
      deletedAccounts: 2,
      deletedCampaigns: 4,
    });
    expect(s.finished[0]?.summary).toMatch(
      /^success: evidence=3 staff_accounts -2 \+\d+ staff_campaigns -4 \+\d+ links=\d+$/,
    );
    expect(report.accounts.every((a) => a.written !== null)).toBe(true);
  });

  it('apply without a writer or a run store is refused before anything happens', async () => {
    const p = ports(sample());
    await expect(
      runFusion(
        { evidence: p.evidence, catalog: p.catalog, staff: p.staff },
        { accountIds: [ACCOUNT], apply: true, today: T },
      ),
    ).rejects.toThrow('apply mode needs');
    expect(p.reads).toEqual([]);
  });

  it('pages through Layer 1 by keyset', async () => {
    const rows = sample();
    const p = ports(rows);
    await runFusion({ ...p }, { accountIds: [ACCOUNT], apply: false, today: T, chunkSize: 1 });
    const mine = p.reads.filter((r) => r.accountId === ACCOUNT);
    expect(mine.map((r) => r.after === null)).toEqual([true, false, false]);
    expect(mine.every((r) => r.limit === 1)).toBe(true);
  });

  it('a missing table (42P01) fails loud, marks the run failed and writes nothing', async () => {
    const p = ports(sample());
    const s = sinks();
    p.evidence.readPage = async () => {
      throw new Error('relation "evidence" does not exist (42P01)');
    };
    await expect(
      runFusion(
        {
          evidence: p.evidence,
          catalog: p.catalog,
          staff: p.staff,
          writer: s.writer,
          runs: s.runs,
        },
        { accountIds: [ACCOUNT], apply: true, today: T },
      ),
    ).rejects.toThrow('42P01');
    expect(s.calls).toEqual(['open', 'finish:failed']);
    expect(s.finished[0]?.summary).toContain('42P01');
  });

  it('a dry-run also fails loud on a missing table, and opens no run', async () => {
    const p = ports(sample());
    p.evidence.readPage = async () => {
      throw new Error('relation "evidence" does not exist (42P01)');
    };
    await expect(
      runFusion({ ...p }, { accountIds: [ACCOUNT], apply: false, today: T }),
    ).rejects.toThrow('42P01');
  });

  it('a writer failure marks the run failed and rethrows', async () => {
    const p = ports(sample());
    const s = sinks();
    s.writer.replaceAccount = async () => {
      throw new Error('relation "staff_accounts" does not exist (42P01)');
    };
    await expect(
      runFusion(
        {
          evidence: p.evidence,
          catalog: p.catalog,
          staff: p.staff,
          writer: s.writer,
          runs: s.runs,
        },
        { accountIds: [ACCOUNT], apply: true, today: T },
      ),
    ).rejects.toThrow('42P01');
    expect(s.calls).toEqual(['open', 'finish:failed']);
  });

  it('rejects a bad chunk size', async () => {
    const p = ports([]);
    await expect(
      runFusion({ ...p }, { accountIds: [ACCOUNT], apply: false, today: T, chunkSize: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it('the report carries counts only: no names, quotes or file ids', async () => {
    const rows = generateInput(3).evidence.slice(0, 30);
    const p = ports(rows);
    const report = await runFusion({ ...p }, { accountIds: [ACCOUNT], apply: false, today: T });
    const text = JSON.stringify(report);
    for (const r of rows) expect(text).not.toContain(r.fileId);
  });
});
