import { describe, expect, it } from 'vitest';
import { runT2, type T2Deps, type T2Options } from '../run';
import {
  ACCOUNT,
  CAMPAIGN,
  MemoryCatalog,
  MemoryFiles,
  MemoryPeople,
  MemoryRuns,
  MemoryStats,
  MemoryWriter,
  PIECE,
  STATS,
  TODAY,
  WINDOW_START,
  roster,
} from './fixtures';

const options = (over: Partial<T2Options> = {}): T2Options => ({
  accountIds: [ACCOUNT],
  apply: false,
  today: TODAY,
  windowStart: WINDOW_START,
  ...over,
});

function deps(over: Partial<T2Deps> = {}): T2Deps {
  return {
    stats: new MemoryStats(),
    index: new MemoryFiles(),
    people: new MemoryPeople(),
    catalog: new MemoryCatalog(),
    roster: roster(),
    ...over,
  };
}

describe('dry-run (the default)', () => {
  it('reports counts per year and writes nothing', async () => {
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    const report = await runT2(deps({ writer, runs }), options());

    expect(writer.calls).toBe(0);
    expect(runs.runs.size).toBe(0);
    expect(report).toMatchObject({ mode: 'dry-run', status: 'success', runId: null });
    // 15 groups: 2023 (1) + 2025 (14). The 2021 row precedes the window, the 2026 row is in the open month.
    expect(report.counters).toEqual({
      filesSeen: 15,
      rowsInserted: 0,
      rowsDuplicate: 0,
      rowsFailed: 0,
    });

    const a = report.accounts[0]!;
    expect(a.months).toEqual({ first: '2021-11', last: '2026-10' });
    expect(Object.keys(a.byYear).sort()).toEqual(['2023', '2025']);

    const y25 = a.byYear['2025']!;
    expect(y25.groups).toBe(14);
    expect(y25.edits).toBe(42);
    expect(y25.byActorClass).toEqual({
      email: 9,
      people_cached: 1,
      people_unresolved: 2,
      unattributed: 1,
      unrecognised: 1,
    });
    expect(y25.skipped).toEqual({
      actor_unresolved: 2,
      actor_unattributed: 1,
      actor_unrecognised: 1,
      file_not_in_index: 1,
      not_content: 1,
      no_project: 2,
    });
    expect(y25.rows.emitted).toBe(5);
    expect(y25.rows.mergedClaims).toBe(1);
    expect(y25.rows.byPersonKind).toEqual({ staff: 3, external_unresolved: 2 });
    expect(y25.uniquePeopleUnresolved).toBe(2);
    expect(y25.uniquePeopleCached).toBe(1);
    expect(y25.uniqueActors).toBe(10);
    expect(y25.editsPeopleUnresolved).toBe(8);
    expect(y25.editsUnattributed).toBe(4);
    expect(y25.peopleUnresolvedShare).toBeCloseTo(2 / 13, 3);
    expect(y25.peopleUnresolvedEditShare).toBeCloseTo(8 / 38, 3);
    expect(y25.notStaffShareOfEmitted).toBeCloseTo(0.4, 3);

    const y23 = a.byYear['2023']!;
    expect(y23.rows.emitted).toBe(1);
    expect(y23.rows.byPersonKind).toEqual({ quarantined: 1 });
    expect(y23.rows.windowGate).toBe(1);
  });

  it('a report carries counts only: no emails, resources, paths or file ids', async () => {
    const text = JSON.stringify(await runT2(deps(), options()));
    for (const needle of ['agency.example', 'client.example', 'people/', 'Acme', 'f1', 'f2']) {
      expect(text).not.toContain(needle);
    }
  });

  it('refuses apply mode without a writer and a run store', async () => {
    await expect(runT2(deps(), options({ apply: true }))).rejects.toThrow(/writer/);
  });

  it('an account without stats yields an empty report', async () => {
    const report = await runT2(deps({ stats: new MemoryStats([]) }), options());
    expect(report.accounts[0]).toMatchObject({ months: null, byYear: {}, status: 'done' });
  });

  it('never reads the open month or months before the window', async () => {
    const stats = new MemoryStats();
    await runT2(deps({ stats }), options());
    const months = new Set(stats.reads.map((r) => r.month));
    expect(months.has('2026-11')).toBe(false);
    expect(months.has('2021-05')).toBe(false);
    expect(months.has('2026-10')).toBe(true);
  });

  it('window none reads from the first stats month', async () => {
    const report = await runT2(deps(), options({ windowStart: null }));
    expect(report.accounts[0]!.months!.first).toBe('2021-05');
    expect(report.accounts[0]!.byYear['2021']!.groups).toBe(1);
  });
});

describe('apply', () => {
  it('writes one row per (file, actor, month) with the T2 shape', async () => {
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    const report = await runT2(deps({ writer, runs }), options({ apply: true }));
    expect(report.status).toBe('success');
    expect(report.counters).toMatchObject({ rowsInserted: 6, rowsDuplicate: 0 });
    expect(writer.rows.size).toBe(6);
    const rows = [...writer.rows.values()];

    for (const r of rows) {
      expect(r.source).toBe('drive_activity');
      expect(r.extractorVersion).toBe('t2-activity-v1');
      expect(r.syncRunId).toBe(report.runId);
      expect(r.roleRaw).toBeNull();
      expect(r.roleNorm).toBeNull();
      expect(r.seniority).toBeNull();
      expect(r.quote).toBeNull();
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.confidence).toBeLessThan(0.7);
      expect(r.periodStart!.slice(0, 7)).toBe(r.periodEnd!.slice(0, 7));
    }

    const march = rows.filter((r) => r.periodStart === '2025-03-01');
    expect(march).toHaveLength(2);
    const u02 = march.find((r) => r.rawName === 'user02@agency.example')!;
    expect(u02).toMatchObject({
      personKind: 'staff',
      periodEnd: '2025-03-31',
      jobNumber: 'ACME55000216',
      campaignId: CAMPAIGN,
      pieceId: PIECE,
      location: 'activity:2025-03;edits=8;days=2',
    });
    expect(u02.confidence).toBeCloseTo(0.1, 6);

    // The cached resource resolved to the roster email; the two spellings are one claim.
    const u07 = rows.filter((r) => r.rawName === 'user07@agency.example');
    expect(u07).toHaveLength(1);
    expect(u07[0]!.personKind).toBe('staff');

    // Campaign-basis file: no job number, no piece.
    const ghost = rows.find((r) => r.rawName === 'ghost@agency.example')!;
    expect(ghost).toMatchObject({
      personKind: 'external_unresolved',
      withheldReason: 'unresolved',
      staffId: null,
      jobNumber: null,
      pieceId: null,
      campaignId: CAMPAIGN,
    });

    // The window gate quarantines (a person who started after the evidence).
    const gated = rows.find((r) => r.rawName === 'user09@agency.example')!;
    expect(gated).toMatchObject({
      personKind: 'quarantined',
      staffId: null,
      periodStart: '2023-06-01',
    });

    // Unresolved people resources are counted, never written.
    expect(rows.some((r) => r.rawName.startsWith('people/'))).toBe(false);
  });

  it('is idempotent: a second run inserts nothing', async () => {
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    await runT2(deps({ writer, runs }), options({ apply: true }));
    const again = await runT2(deps({ writer, runs }), options({ apply: true }));
    expect(again.counters.rowsInserted).toBe(0);
    expect(again.counters.rowsDuplicate).toBe(6);
    expect(writer.rows.size).toBe(6);
  });

  it('a later run with more edits in an emitted month adds nothing (counts are not in the claim)', async () => {
    const writer = new MemoryWriter();
    await runT2(deps({ writer, runs: new MemoryRuns() }), options({ apply: true }));
    const more = new MemoryStats([
      ...STATS,
      { fileId: 'f1', actor: 'user02@agency.example', day: '2025-03-28', edits: 40 },
    ]);
    const again = await runT2(
      deps({ writer, runs: new MemoryRuns(), stats: more }),
      options({ apply: true }),
    );
    expect(again.counters.rowsInserted).toBe(0);
    expect(writer.rows.size).toBe(6);
  });

  it('a new month of activity adds only that month', async () => {
    const writer = new MemoryWriter();
    await runT2(deps({ writer, runs: new MemoryRuns() }), options({ apply: true }));
    const more = new MemoryStats([
      ...STATS,
      { fileId: 'f1', actor: 'user02@agency.example', day: '2025-05-02', edits: 1 },
    ]);
    const again = await runT2(
      deps({ writer, runs: new MemoryRuns(), stats: more }),
      options({ apply: true }),
    );
    expect(again.counters.rowsInserted).toBe(1);
  });

  it('a person resolved later (cache filled) is emitted by the next run', async () => {
    const writer = new MemoryWriter();
    const first = await runT2(deps({ writer, runs: new MemoryRuns() }), options({ apply: true }));
    const filled = new MemoryPeople({
      'people/100': 'user07@agency.example',
      'people/200': 'user05@agency.example',
      'people/300': null,
    });
    const again = await runT2(
      deps({ writer, runs: new MemoryRuns(), people: filled }),
      options({ apply: true }),
    );
    expect(first.counters.rowsInserted).toBe(6);
    expect(again.counters.rowsInserted).toBe(1);
    expect([...writer.rows.values()].some((r) => r.rawName === 'user05@agency.example')).toBe(true);
  });

  it('marks the run failed and rethrows when a write fails', async () => {
    const writer = new MemoryWriter();
    writer.failOnCall = 1;
    const runs = new MemoryRuns();
    await expect(runT2(deps({ writer, runs }), options({ apply: true }))).rejects.toThrow(
      /simulated/,
    );
    const run = [...runs.runs.values()][0]!;
    expect(run.status).toBe('failed');
    expect(run.summary).toMatch(/^failed: simulated/);
  });

  it('records the unknown start dates it was told about', async () => {
    const runs = new MemoryRuns();
    const report = await runT2(
      deps({ writer: new MemoryWriter(), runs }),
      options({ apply: true, unknownStartDates: ['2000-01-01'] }),
    );
    expect(report.unknownStartDates).toEqual(['2000-01-01']);
    expect([...runs.runs.values()][0]!.details['unknown_start_dates']).toEqual(['2000-01-01']);
  });
});

describe('resume and pause', () => {
  it('pauses at a page boundary and a resumed run completes with the same rows as one full run', async () => {
    const full = new MemoryWriter();
    await runT2(deps({ writer: full, runs: new MemoryRuns() }), options({ apply: true }));

    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    let t = 0;
    const now = () => (t += 10);
    const first = await runT2(
      deps({ writer, runs, now }),
      options({ apply: true, chunkSize: 2, budgetMs: 1 }),
    );
    expect(first.status).toBe('paused');
    expect(first.accounts[0]!.status).toBe('paused');
    const runId = first.runId!;
    expect(runs.runs.get(runId)!.status).toBe('paused');
    expect(runs.runs.get(runId)!.checkpoint).not.toBeNull();

    let guard = 0;
    let last = first;
    while (last.status === 'paused' && guard++ < 50) {
      last = await runT2(
        deps({ writer, runs, now }),
        options({ apply: true, chunkSize: 2, budgetMs: 1, resumeRunId: runId }),
      );
    }
    expect(last.status).toBe('success');
    expect(writer.rows.size).toBe(full.rows.size);
    expect([...writer.rows.keys()].sort()).toEqual([...full.rows.keys()].sort());
  });

  it('a month that fills the last page exactly still completes', async () => {
    // 2025-03 has exactly two groups: chunk 2 fills the page, the next read is empty.
    const writer = new MemoryWriter();
    const runs = new MemoryRuns();
    const report = await runT2(deps({ writer, runs }), options({ apply: true, chunkSize: 2 }));
    expect(report.status).toBe('success');
    expect(writer.rows.size).toBe(6);
  });

  it('resuming a finished-account checkpoint (month null) reads nothing for it', async () => {
    const runs = new MemoryRuns();
    const id = await runs.open({});
    await runs.saveProgress(
      id,
      { accountId: ACCOUNT, month: null, after: null, doneAccountIds: [] },
      { filesSeen: 0, rowsInserted: 0, rowsDuplicate: 0, rowsFailed: 0 },
    );
    const stats = new MemoryStats();
    const report = await runT2(
      deps({ stats, writer: new MemoryWriter(), runs }),
      options({ apply: true, resumeRunId: id }),
    );
    expect(stats.reads).toHaveLength(0);
    expect(report.status).toBe('success');
  });

  it('rejects a bad chunk size', async () => {
    await expect(runT2(deps(), options({ chunkSize: 0 }))).rejects.toThrow(RangeError);
  });
});

describe('no outside calls', () => {
  it('the stage sources import no Google client, People API or forward driver', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '..');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      const imports = text.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l));
      for (const line of imports) {
        expect(line).not.toMatch(
          /googleapis|forward\/|workspace|drive\/client|undici|anthropic|vertex/i,
        );
      }
    }
  });
});
