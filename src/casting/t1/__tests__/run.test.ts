import { describe, expect, it } from 'vitest';
import { runT1, type T1Deps, type T1Options } from '../run';
import {
  ACCOUNT,
  CAMPAIGN,
  MemoryCatalog,
  MemoryIndex,
  MemoryRuns,
  MemoryWriter,
  PIECE,
  TODAY,
  WINDOW_START,
  roster,
  scenarioFiles,
} from './fixtures';

const options = (over: Partial<T1Options> = {}): T1Options => ({
  accountIds: [ACCOUNT],
  apply: false,
  today: TODAY,
  windowStart: WINDOW_START,
  ...over,
});

function deps(over: Partial<T1Deps> = {}): T1Deps {
  return {
    index: new MemoryIndex(scenarioFiles()),
    catalog: new MemoryCatalog(),
    roster: roster(),
    ...over,
  };
}

describe('dry-run (the default)', () => {
  it('reports counts per account shape and writes nothing', async () => {
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    const report = await runT1(deps({ writer, runs }), options());

    expect(writer.calls).toBe(0);
    expect(runs.runs.size).toBe(0);
    expect(report).toMatchObject({
      mode: 'dry-run',
      status: 'success',
      runId: null,
      windowStart: WINDOW_START,
    });
    expect(report.counters).toMatchObject({ rowsInserted: 0, rowsDuplicate: 0 });

    const a = report.accounts[0]!;
    expect(a.filesSeen).toBe(13);
    expect(a.filesByModifiedYear).toEqual({ '2025': 12, unknown: 1 });
    expect(a.prefixes).toBe(1);
    expect(a.projects.total).toBe(5);
    expect(a.projects.byStrength).toEqual({
      job_code: 1,
      job_code_weak: 1,
      name_key: 2,
      campaign: 1,
    });
    expect(a.projects.byPeriodBasis).toEqual({ folder_year: 4, campaign_dates: 1 });
    expect(a.projects.outOfWindow).toBe(1);
    expect(a.skipped).toEqual({ not_content: 1, no_modifier: 1, no_project: 1, out_of_window: 1 });
    expect(a.rows.emitted).toBe(9);
    expect(a.rows.byPersonKind).toEqual({ staff: 6, external_unresolved: 3 });
    expect(a.rows.byStrength).toEqual({ job_code: 6, job_code_weak: 1, name_key: 1, campaign: 1 });
    expect(a.rows.byPeriodYear).toEqual({ '2025': 7, '2021': 1, '2024': 1 });
    expect(a.rows.unresolvedShare).toBeCloseTo(0.333, 3);
  });

  it('a report carries counts only: no emails, paths, names or file ids', async () => {
    const report = await runT1(deps(), options());
    const text = JSON.stringify(report);
    for (const needle of ['agency.example', 'client.example', 'Lumi', 'Acme', 'f000']) {
      expect(text).not.toContain(needle);
    }
  });

  it('refuses apply mode without a writer and a run store', async () => {
    await expect(runT1(deps(), options({ apply: true }))).rejects.toThrow(/writer/);
  });
});

describe('index row choice counters', () => {
  it('counts account-rooted, legacy-path-only, pair-campaign and unused newer rows apart', async () => {
    const files = scenarioFiles();
    files[0] = { ...files[0]!, campaignFromPair: true };
    files[1] = { ...files[1]!, accountRooted: false };
    files[2] = { ...files[2]!, newerRowOtherRun: true };
    const report = await runT1(deps({ index: new MemoryIndex(files) }), options());
    expect(report.accounts[0]!.index).toEqual({
      accountRooted: 12,
      legacyPathOnly: 1,
      campaignFromPair: 1,
      newerRowOtherRun: 1,
    });
  });

  it('a dry-run of the plain scenario reports every file as account-rooted', async () => {
    const report = await runT1(deps(), options());
    expect(report.accounts[0]!.index).toEqual({
      accountRooted: 13,
      legacyPathOnly: 0,
      campaignFromPair: 0,
      newerRowOtherRun: 0,
    });
  });
});

describe('apply', () => {
  it('writes through the writer under a sync run, with project references and the window applied', async () => {
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    const report = await runT1(deps({ writer, runs }), options({ apply: true }));

    expect(report).toMatchObject({ mode: 'apply', status: 'success', runId: 'run-1' });
    expect(report.counters).toMatchObject({ rowsInserted: 9, rowsDuplicate: 0 });
    expect(runs.runs.get('run-1')).toMatchObject({ status: 'success' });
    const rows = [...writer.rows.values()];
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.syncRunId === 'run-1' && r.source === 'drive_metadata')).toBe(true);

    const coded = rows.filter((r) => r.jobNumber === 'ACME55000216');
    expect(coded).toHaveLength(6);
    expect(coded.every((r) => r.pieceId === PIECE && r.campaignId === CAMPAIGN)).toBe(true);
    expect(coded.every((r) => r.periodStart === '2025-01-01' && r.periodEnd === '2025-12-31')).toBe(
      true,
    );

    const named = rows.find((r) => r.location?.startsWith('name:'))!;
    expect(named.jobNumber).toBeNull();
    expect(named.periodStart).toBe(WINDOW_START); // truncated at the window start
    expect(named.periodEnd).toBe('2021-12-31');

    const campaign = rows.find((r) => r.jobNumber === null && r.campaignId === CAMPAIGN)!;
    expect(campaign).toMatchObject({
      periodStart: '2024-02-01',
      periodEnd: '2024-09-30',
      pieceId: null,
    });
  });

  it('is idempotent: a second run inserts nothing', async () => {
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    await runT1(deps({ writer, runs }), options({ apply: true }));
    const again = await runT1(deps({ writer, runs }), options({ apply: true }));
    expect(again.counters).toMatchObject({ rowsInserted: 0, rowsDuplicate: 9 });
    expect(writer.rows.size).toBe(9);
  });

  it('does not depend on the page size', async () => {
    const hashesFor = async (chunkSize: number) => {
      const writer = new MemoryWriter();
      await runT1(deps({ writer, runs: new MemoryRuns() }), options({ apply: true, chunkSize }));
      return [...writer.rows.values()].map((r) => r.claimHash).sort();
    };
    const whole = await hashesFor(1000);
    expect(await hashesFor(1)).toEqual(whole);
    expect(await hashesFor(4)).toEqual(whole);
  });

  it('streams in pages: a small page size means many index reads, never one big one', async () => {
    const index = new MemoryIndex(scenarioFiles());
    await runT1(
      deps({ index, writer: new MemoryWriter(), runs: new MemoryRuns() }),
      options({ apply: true, chunkSize: 4 }),
    );
    expect(index.calls).toBeGreaterThanOrEqual(3 * 4); // three passes, 13 files, 4 per page
  });

  it('pauses at a page boundary when the budget is spent, and a resume finishes without duplicates', async () => {
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    let t = 0;
    const now = () => (t += 100);
    const first = await runT1(
      deps({ writer, runs, now }),
      options({ apply: true, chunkSize: 4, budgetMs: 150 }),
    );
    expect(first.status).toBe('paused');
    expect(runs.runs.get('run-1')).toMatchObject({ status: 'paused' });
    expect(runs.runs.get('run-1')!.checkpoint?.afterFileId).not.toBeNull();
    const partial = writer.rows.size;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(9);

    const second = await runT1(
      deps({ writer, runs }),
      options({ apply: true, chunkSize: 4, resumeRunId: 'run-1' }),
    );
    expect(second.status).toBe('success');
    expect(writer.rows.size).toBe(9);
    expect(first.counters.rowsInserted + second.counters.rowsInserted).toBe(9);
    expect(second.counters.rowsDuplicate).toBe(0); // resumed after the checkpoint: nothing re-sent
  });

  it('marks the run failed on a write error, and a resume completes the rest', async () => {
    const writer = new MemoryWriter();
    writer.failOnCall = 2;
    const runs = new MemoryRuns();
    await expect(
      runT1(deps({ writer, runs }), options({ apply: true, chunkSize: 4 })),
    ).rejects.toThrow(/simulated/);
    expect(runs.runs.get('run-1')).toMatchObject({ status: 'failed' });
    writer.failOnCall = null;
    const resumed = await runT1(
      deps({ writer, runs }),
      options({ apply: true, chunkSize: 4, resumeRunId: 'run-1' }),
    );
    expect(resumed.status).toBe('success');
    expect(writer.rows.size).toBe(9);
  });

  it('skips accounts already done on resume', async () => {
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const files = [
      ...scenarioFiles(),
      ...scenarioFiles().map((f) => ({ ...f, fileId: `o${f.fileId}`, accountId: OTHER })),
    ];
    const d = () => deps({ index: new MemoryIndex(files), writer, runs });
    const r1 = await runT1(
      d(),
      options({ apply: true, accountIds: [ACCOUNT, OTHER], chunkSize: 5 }),
    );
    expect(r1.accounts.map((a) => a.accountId)).toEqual([ACCOUNT, OTHER]);
    // Pretend the second account never finished.
    runs.runs.get('run-1')!.checkpoint = {
      accountId: OTHER,
      afterFileId: null,
      doneAccountIds: [ACCOUNT],
    };
    const r2 = await runT1(
      d(),
      options({ apply: true, accountIds: [ACCOUNT, OTHER], chunkSize: 5, resumeRunId: 'run-1' }),
    );
    expect(r2.accounts.map((a) => a.accountId)).toEqual([OTHER]);
    expect(r2.counters.rowsDuplicate).toBe(9);
  });
});
