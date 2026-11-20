/** Synthetic fakes for the backfill tests. No Drive, People API, database or model is touched. */
import type {
  AccountReader,
  ActivitySource,
  BackfillCheckpoint,
  BackfillCounters,
  BackfillRunStore,
  EditStatsWriter,
  ExistingRun,
  ExistingStatsReader,
  FoldedWindow,
  PeopleMapReader,
} from '../types';

export const ACCOUNT = '11111111-1111-4111-8111-111111111111';
export const ROOT = 'root-folder';
export const TODAY = new Date(Date.UTC(2026, 10, 19));

export class FakeExisting implements ExistingStatsReader {
  reads = 0;
  constructor(public runs_: ExistingRun[] = []) {}
  async runs(): Promise<ExistingRun[]> {
    this.reads += 1;
    return this.runs_;
  }
}

export class FakeAccounts implements AccountReader {
  constructor(private readonly root: string | null = ROOT) {}
  async driveRoot(): Promise<string | null> {
    return this.root;
  }
}

/** Returns the same tallies for every window unless overridden; counts calls. */
export class FakeActivity implements ActivitySource {
  fetches: Array<{ fromIso: string; toIso: string }> = [];
  failOnFetch: number | null = null;
  constructor(
    private readonly tallies: Map<string, number> = new Map([
      ['fileA|people/1', 2],
      ['fileA|people/2', 1],
      ['fileB|a@b.example', 4],
    ]),
    private readonly callsPerWindow = 1,
  ) {}
  async foldWindow(root: string, fromIso: string, toIso: string): Promise<FoldedWindow> {
    if (root !== ROOT) throw new Error('wrong root');
    this.fetches.push({ fromIso, toIso });
    if (this.failOnFetch === this.fetches.length) throw new Error('simulated activity failure');
    return { tallies: this.tallies, events: 7, calls: this.callsPerWindow };
  }
}

/** Mirrors writeRunEditStats: collapse to (file, email), replace every row of the run id. */
export class FakeWriter implements EditStatsWriter {
  readonly byRun = new Map<string, Map<string, number>>();
  readonly days = new Map<string, string>();
  calls = 0;
  async replaceWindow(args: {
    accountId: string;
    syncRunId: string;
    day: string;
    tallies: ReadonlyMap<string, number>;
    actorEmailBy: ReadonlyMap<string, string>;
  }): Promise<number> {
    this.calls += 1;
    const rows = new Map<string, number>();
    for (const [key, n] of args.tallies) {
      const [file, actor] = key.split('|') as [string, string];
      const k = `${file}|${args.actorEmailBy.get(actor) ?? actor}`;
      rows.set(k, (rows.get(k) ?? 0) + n);
    }
    this.byRun.set(args.syncRunId, rows);
    this.days.set(args.syncRunId, args.day);
    return rows.size;
  }
  /** What every reader sees: the sum over run ids. */
  total(): Map<string, number> {
    const out = new Map<string, number>();
    for (const rows of this.byRun.values())
      for (const [k, n] of rows) out.set(k, (out.get(k) ?? 0) + n);
    return out;
  }
}

export class FakePeople implements PeopleMapReader {
  lookups = 0;
  constructor(
    private readonly map: Record<string, string | null> = { 'people/1': 'one@agency.example' },
  ) {}
  async lookup(resources: readonly string[]): Promise<Map<string, string | null>> {
    this.lookups += 1;
    const out = new Map<string, string | null>();
    for (const r of resources) if (r in this.map) out.set(r, this.map[r] as string | null);
    return out;
  }
}

export class FakeRuns implements BackfillRunStore {
  runs = new Map<
    string,
    {
      status: string;
      checkpoint: BackfillCheckpoint | null;
      counters: BackfillCounters;
      summary: string;
      details: Record<string, unknown>;
    }
  >();
  async open(details: Record<string, unknown>): Promise<string> {
    const id = `run-${this.runs.size + 1}`;
    this.runs.set(id, {
      status: 'running',
      checkpoint: null,
      counters: { windowsDone: 0, events: 0, calls: 0, statRows: 0 },
      summary: '',
      details,
    });
    return id;
  }
  async saveProgress(id: string, cp: BackfillCheckpoint, c: BackfillCounters): Promise<void> {
    const r = this.runs.get(id)!;
    r.checkpoint = { ...cp };
    r.counters = { ...c };
  }
  async loadCheckpoint(id: string): Promise<BackfillCheckpoint | null> {
    const r = this.runs.get(id);
    if (!r) throw new Error('no run');
    r.status = 'running';
    return r.checkpoint;
  }
  async finish(
    id: string,
    status: 'success' | 'failed' | 'paused',
    c: BackfillCounters,
    summary: string,
  ) {
    const r = this.runs.get(id)!;
    r.status = status;
    r.counters = { ...c };
    r.summary = summary;
  }
}
