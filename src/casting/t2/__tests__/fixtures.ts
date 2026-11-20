/**
 * Synthetic data and in-memory ports for the T2 tests. Every name, email, code
 * and id is invented; no live database, Drive, People API or model is touched.
 */
import { buildRosterIndex, type RosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import type {
  CatalogReader,
  EvidenceInsertRow,
  EvidenceWriter,
  FileIndexLookup,
  IndexFileRow,
  PeopleMapReader,
  ProjectCatalog,
  RunCounters,
  StatsCursor,
  StatsGroup,
  StatsReader,
  T2Checkpoint,
  T2RunStore,
} from '../types';

export const ACCOUNT = '11111111-1111-4111-8111-111111111111';
export const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
export const PIECE = '33333333-3333-4333-8333-333333333333';
export const TODAY = new Date(Date.UTC(2026, 10, 19));
export const WINDOW_START = '2021-11-19';

export function roster(): RosterIndex {
  return buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });
}

export const CATALOG: ProjectCatalog = {
  campaigns: [{ id: CAMPAIGN, awardedAt: '2024-02-01', liveAt: null, endsAt: '2024-09-30' }],
  pieces: [{ id: PIECE, campaignId: CAMPAIGN, jobNumber: 'ACME55000216' }],
};

const idx = (over: Partial<IndexFileRow> & { fileId: string; path: string }): IndexFileRow => ({
  accountId: ACCOUNT,
  campaignId: null,
  name: over.path.split(' / ').pop() as string,
  mimeType: 'application/pdf',
  modifiedTime: new Date('2025-04-10T10:00:00Z'),
  modifiedBy: null,
  accountRooted: true,
  campaignFromPair: false,
  newerRowOtherRun: false,
  ...over,
});

export const FILES: IndexFileRow[] = [
  // strict code in a folder name, known to the catalog: piece and campaign
  idx({
    fileId: 'f1',
    path: 'Acme / Master / 2025 / 13. Acme | Spring [ACME55000216] / Strategy / brief.pdf',
  }),
  // no code, attributed by the index: campaign basis
  idx({ fileId: 'f2', path: 'Acme / Misc / loose.pdf', campaignId: CAMPAIGN }),
  // no code, no campaign: no project
  idx({ fileId: 'f3', path: 'Acme / Misc / nothing.pdf' }),
  // a folder
  idx({
    fileId: 'f4',
    path: 'Acme / Misc',
    mimeType: 'application/vnd.google-apps.folder',
    campaignId: CAMPAIGN,
  }),
  // campaign the catalog does not know (deleted or merged): dropped, so no project
  idx({
    fileId: 'f5',
    path: 'Acme / Misc / orphan.pdf',
    campaignId: '99999999-9999-4999-8999-999999999999',
  }),
];

export interface StatRow {
  fileId: string;
  actor: string;
  day: string;
  edits: number;
}

const s = (fileId: string, actor: string, day: string, edits: number): StatRow => ({
  fileId,
  actor,
  day,
  edits,
});

/** The scenario of the run tests: every actor class and every skip reason once. */
export const STATS: StatRow[] = [
  // before the window: never read
  s('f1', 'user02@agency.example', '2021-05-10', 9),
  // 2023-06: a person who started later than the evidence (window gate)
  s('f1', 'user09@agency.example', '2023-06-30', 1),
  // 2025-03: one actor on two days (one group), another on one
  s('f1', 'user02@agency.example', '2025-03-05', 3),
  s('f1', 'user02@agency.example', '2025-03-20', 5),
  s('f1', 'user03@agency.example', '2025-03-20', 2),
  // 2025-04: all actor classes and skip reasons
  s('f1', '(unattributed)', '2025-04-02', 4),
  s('f1', 'USER07@Agency.Example', '2025-04-02', 1),
  s('f1', 'people/100', '2025-04-02', 12), // cached -> user07: same claim as the line above
  s('f1', 'people/200', '2025-04-02', 6), // not in the cache
  s('f1', 'people/300', '2025-04-02', 2), // cached without an email
  s('f1', 'weird actor', '2025-04-02', 1),
  s('f2', 'ghost@agency.example', '2025-04-10', 1), // agency domain, not in the roster
  s('f2', 'vendor@client.example', '2025-04-10', 1), // another domain
  s('f3', 'user02@agency.example', '2025-04-11', 1), // no project
  s('f4', 'user02@agency.example', '2025-04-11', 1), // folder
  s('f6', 'user02@agency.example', '2025-04-11', 1), // not in the index
  s('f5', 'user02@agency.example', '2025-04-11', 1), // unknown campaign: no project
  // the open month (the run date is in 2026-11): never read
  s('f1', 'user02@agency.example', '2026-11-03', 7),
];

export const PEOPLE: Record<string, string | null> = {
  'people/100': 'user07@agency.example',
  'people/300': null,
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Aggregates like the SQL does: one group per (file, actor) inside one month. */
export class MemoryStats implements StatsReader {
  reads: Array<{ month: string; after: StatsCursor | null }> = [];
  constructor(private readonly rows: StatRow[] = STATS) {}

  async range(): Promise<{ minDay: string; maxDay: string } | null> {
    if (this.rows.length === 0) return null;
    const days = this.rows.map((r) => r.day).sort(cmp);
    return { minDay: days[0] as string, maxDay: days[days.length - 1] as string };
  }

  async readPage(
    _accountId: string,
    month: string,
    after: StatsCursor | null,
    limit: number,
  ): Promise<StatsGroup[]> {
    this.reads.push({ month, after });
    const groups = new Map<string, StatsGroup & { dayset: Set<string> }>();
    for (const r of this.rows) {
      if (r.day.slice(0, 7) !== month) continue;
      const key = `${r.fileId}\u0000${r.actor}`;
      const g = groups.get(key) ?? {
        fileId: r.fileId,
        actor: r.actor,
        firstDay: r.day,
        lastDay: r.day,
        days: 0,
        edits: 0,
        dayset: new Set<string>(),
      };
      g.firstDay = r.day < g.firstDay ? r.day : g.firstDay;
      g.lastDay = r.day > g.lastDay ? r.day : g.lastDay;
      g.dayset.add(r.day);
      g.days = g.dayset.size;
      g.edits += r.edits;
      groups.set(key, g);
    }
    return [...groups.values()]
      .map(({ dayset: _d, ...g }) => g)
      .filter(
        (g) =>
          after === null ||
          cmp(g.fileId, after.fileId) > 0 ||
          (g.fileId === after.fileId && cmp(g.actor, after.actor) > 0),
      )
      .sort((a, b) => cmp(a.fileId, b.fileId) || cmp(a.actor, b.actor))
      .slice(0, limit);
  }
}

export class MemoryFiles implements FileIndexLookup {
  lookups = 0;
  constructor(private readonly files: IndexFileRow[] = FILES) {}
  async lookup(accountId: string, ids: readonly string[]): Promise<Map<string, IndexFileRow>> {
    this.lookups += 1;
    const out = new Map<string, IndexFileRow>();
    for (const f of this.files)
      if (f.accountId === accountId && ids.includes(f.fileId)) out.set(f.fileId, f);
    return out;
  }
}

export class MemoryPeople implements PeopleMapReader {
  constructor(private readonly map: Record<string, string | null> = PEOPLE) {}
  async lookup(resources: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const r of resources) if (r in this.map) out.set(r, this.map[r] as string | null);
    return out;
  }
}

export class MemoryCatalog implements CatalogReader {
  constructor(private readonly catalog: ProjectCatalog = CATALOG) {}
  async load(): Promise<ProjectCatalog> {
    return this.catalog;
  }
}

/** Honours the unique key (extractor_version, claim_hash) like the table does. */
export class MemoryWriter implements EvidenceWriter {
  readonly rows = new Map<string, EvidenceInsertRow>();
  calls = 0;
  failOnCall: number | null = null;
  async insertBatch(rows: readonly EvidenceInsertRow[]): Promise<{ inserted: number }> {
    this.calls += 1;
    if (this.failOnCall === this.calls) throw new Error('simulated write failure');
    let inserted = 0;
    for (const r of rows) {
      const key = `${r.extractorVersion}|${r.claimHash}`;
      if (!this.rows.has(key)) {
        this.rows.set(key, r);
        inserted += 1;
      }
    }
    return { inserted };
  }
}

export class MemoryRuns implements T2RunStore {
  runs = new Map<
    string,
    {
      status: string;
      checkpoint: T2Checkpoint | null;
      counters: RunCounters;
      summary: string;
      details: Record<string, unknown>;
    }
  >();
  async open(details: Record<string, unknown>): Promise<string> {
    const id = `run-${this.runs.size + 1}`;
    this.runs.set(id, {
      status: 'running',
      checkpoint: null,
      counters: { filesSeen: 0, rowsInserted: 0, rowsDuplicate: 0, rowsFailed: 0 },
      summary: '',
      details,
    });
    return id;
  }
  async saveProgress(
    runId: string,
    checkpoint: T2Checkpoint,
    counters: RunCounters,
  ): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new Error('no run');
    r.checkpoint = { ...checkpoint, doneAccountIds: [...checkpoint.doneAccountIds] };
    r.counters = counters;
  }
  async loadCheckpoint(runId: string): Promise<T2Checkpoint | null> {
    const r = this.runs.get(runId);
    if (!r) throw new Error('no run');
    r.status = 'running';
    return r.checkpoint;
  }
  async finish(
    runId: string,
    status: 'success' | 'failed' | 'paused',
    counters: RunCounters,
    summary: string,
  ): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new Error('no run');
    r.status = status;
    r.counters = counters;
    r.summary = summary;
  }
}
