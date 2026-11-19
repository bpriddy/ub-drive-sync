import { describe, expect, it } from 'vitest';
import { OverlapError } from '../overlap';
import { runBackfill, type BackfillDeps, type BackfillOptions } from '../run';
import { planWindows } from '../windows';
import {
  ACCOUNT,
  FakeAccounts,
  FakeActivity,
  FakeExisting,
  FakePeople,
  FakeRuns,
  FakeWriter,
  TODAY,
} from './fixtures';

const options = (over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  accountId: ACCOUNT,
  from: '2025-01-01',
  to: '2025-03-02',
  windowDays: 30,
  confirm: false,
  today: TODAY,
  ...over,
});

function deps(over: Partial<BackfillDeps> = {}) {
  const existing = new FakeExisting();
  const activity = new FakeActivity();
  const writer = new FakeWriter();
  const people = new FakePeople();
  const runs = new FakeRuns();
  const base: BackfillDeps = {
    existing,
    accounts: new FakeAccounts(),
    activity,
    writer,
    people,
    runs,
    ...over,
  };
  return { base, existing, activity, writer, people, runs };
}

describe('dry-run (the default)', () => {
  it('prints windows and the estimate, and writes and fetches nothing', async () => {
    const d = deps();
    const r = await runBackfill(d.base, options());
    expect(r).toMatchObject({ mode: 'dry-run', status: 'success', runId: null, windowDays: 30 });
    expect(r.windows).toHaveLength(2);
    expect(r.windows[0]).toMatchObject({
      index: 0,
      start: '2025-01-01',
      end: '2025-01-31',
      day: '2025-01-31',
    });
    expect(r.estimate).toMatchObject({ windows: 2, minCalls: 2, peopleApiCalls: 0 });
    expect(r.windowsRemaining).toBe(2);
    expect(d.activity.fetches).toHaveLength(0);
    expect(d.writer.calls).toBe(0);
    expect(d.people.lookups).toBe(0);
    expect(d.runs.runs.size).toBe(0);
    expect(d.existing.reads).toBe(1);
  });

  it('refuses an overlap in dry-run too (hard error)', async () => {
    const d = deps({
      existing: new FakeExisting([
        { syncRunId: 'r', minDay: '2025-02-01', maxDay: '2025-02-01', rows: 1 },
      ]),
    });
    await expect(runBackfill(d.base, options())).rejects.toBeInstanceOf(OverlapError);
  });

  it('needs a Drive root', async () => {
    await expect(
      runBackfill(deps({ accounts: new FakeAccounts(null) }).base, options()),
    ).rejects.toThrow(/Drive root/);
  });

  it('confirm needs every port; resume needs confirm', async () => {
    const d = deps();
    await expect(
      runBackfill({ ...d.base, activity: undefined }, options({ confirm: true })),
    ).rejects.toThrow(/confirm mode needs/);
    await expect(runBackfill(d.base, options({ resumeRunId: 'x' }))).rejects.toThrow(
      /resume needs confirm/,
    );
  });

  it('a report carries counts only: no emails, resources or file ids', async () => {
    const d = deps();
    const text = JSON.stringify(await runBackfill(d.base, options({ confirm: true })));
    for (const needle of ['agency.example', 'b.example', 'people/', 'fileA', 'fileB']) {
      expect(text).not.toContain(needle);
    }
  });
});

describe('confirm', () => {
  it('processes windows oldest first, one commit per window, dated by the window end', async () => {
    const d = deps();
    const r = await runBackfill(d.base, options({ confirm: true }));
    expect(r).toMatchObject({ mode: 'confirm', status: 'success', windowsRemaining: 0 });
    expect(d.activity.fetches.map((f) => f.toIso)).toEqual([
      '2025-01-31T00:00:00.000Z',
      '2025-03-02T00:00:00.000Z',
    ]);
    const w = planWindows({
      accountId: ACCOUNT,
      from: '2025-01-01',
      to: '2025-03-02',
      windowDays: 30,
      today: TODAY,
    });
    expect(d.writer.days.get(w[0]!.runId)).toBe('2025-01-31');
    expect(d.writer.days.get(w[1]!.runId)).toBe('2025-03-02');
    expect(r.counters).toEqual({ windowsDone: 2, events: 14, calls: 2, statRows: 6 });
    expect(d.runs.runs.get(r.runId!)!.checkpoint).toEqual({ accountId: ACCOUNT, nextWindow: 2 });
    expect(d.runs.runs.get(r.runId!)!.status).toBe('success');
  });

  it('maps people resources through the cache only; unresolved stay raw and are counted', async () => {
    const d = deps();
    const r = await runBackfill(d.base, options({ confirm: true, to: '2025-01-31' }));
    const rows = [...d.writer.byRun.values()][0]!;
    expect([...rows.keys()].sort()).toEqual([
      'fileA|one@agency.example',
      'fileA|people/2',
      'fileB|a@b.example',
    ]);
    expect(r.actors).toEqual({ unique: 3, cached: 1, unresolvedKeptRaw: 1 });
  });

  it('is idempotent: a retry replaces its own rows, counters do not double', async () => {
    const d = deps();
    await runBackfill(d.base, options({ confirm: true }));
    const once = d.writer.total();
    // The retry sees its own run ids in the table: exempt from the overlap check.
    const w = planWindows({
      accountId: ACCOUNT,
      from: '2025-01-01',
      to: '2025-03-02',
      windowDays: 30,
      today: TODAY,
    });
    d.existing.runs_ = w.map((x) => ({
      syncRunId: x.runId,
      minDay: x.day,
      maxDay: x.day,
      rows: 3,
    }));
    await runBackfill(d.base, options({ confirm: true }));
    expect(d.writer.byRun.size).toBe(2);
    expect(d.writer.total()).toEqual(once);
  });

  it('contrast: random run ids (the old seed) over the same events double the counters', () => {
    const w = new FakeWriter();
    const t = new Map([['fileA|a@b.example', 3]]);
    const args = {
      accountId: ACCOUNT,
      day: '2025-01-31',
      tallies: t,
      actorEmailBy: new Map<string, string>(),
    };
    void w.replaceWindow({ ...args, syncRunId: 'random-1' });
    void w.replaceWindow({ ...args, syncRunId: 'random-2' });
    expect(w.total().get('fileA|a@b.example')).toBe(6);
  });

  it('marks the run failed and rethrows; a committed window stays committed', async () => {
    const d = deps();
    d.activity.failOnFetch = 2;
    await expect(runBackfill(d.base, options({ confirm: true }))).rejects.toThrow(/simulated/);
    const run = [...d.runs.runs.values()][0]!;
    expect(run.status).toBe('failed');
    expect(run.checkpoint).toEqual({ accountId: ACCOUNT, nextWindow: 1 });
    expect(d.writer.byRun.size).toBe(1);
  });
});

describe('resume and budget', () => {
  it('pauses on the call budget and resumes without refetching committed windows', async () => {
    const d = deps();
    const first = await runBackfill(d.base, options({ confirm: true, maxCalls: 1 }));
    expect(first).toMatchObject({ status: 'paused', windowsRemaining: 1 });
    expect(d.runs.runs.get(first.runId!)!.status).toBe('paused');
    expect(d.activity.fetches).toHaveLength(1);

    const second = await runBackfill(
      d.base,
      options({ confirm: true, resumeRunId: first.runId, maxCalls: 1 }),
    );
    expect(second.status).toBe('success');
    expect(d.activity.fetches).toHaveLength(2);
    expect(second.counters.windowsDone).toBe(2);
    expect(d.writer.byRun.size).toBe(2);
  });

  it('pauses on the time budget, never after the last window', async () => {
    let t = 0;
    const d = deps({ now: () => (t += 1000) });
    const r = await runBackfill(d.base, options({ confirm: true, budgetMs: 1 }));
    expect(r.status).toBe('paused');
    const d2 = deps({ now: () => (t += 1000) });
    const one = await runBackfill(
      d2.base,
      options({ confirm: true, to: '2025-01-31', budgetMs: 1 }),
    );
    expect(one.status).toBe('success');
  });

  it("refuses to resume another account's run", async () => {
    const d = deps();
    const first = await runBackfill(d.base, options({ confirm: true, maxCalls: 1 }));
    d.runs.runs.get(first.runId!)!.checkpoint = { accountId: 'other', nextWindow: 1 };
    await expect(
      runBackfill(d.base, options({ confirm: true, resumeRunId: first.runId })),
    ).rejects.toThrow(/another account/);
  });

  it('a resumed run still enforces the overlap check', async () => {
    const d = deps();
    const first = await runBackfill(d.base, options({ confirm: true, maxCalls: 1 }));
    d.existing.runs_ = [
      { syncRunId: 'foreign', minDay: '2025-02-10', maxDay: '2025-02-10', rows: 1 },
    ];
    await expect(
      runBackfill(d.base, options({ confirm: true, resumeRunId: first.runId })),
    ).rejects.toBeInstanceOf(OverlapError);
  });
});
