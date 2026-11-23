/**
 * Synthetic data and in-memory ports for the T1 tests. Every name, email, code
 * and id is invented; no live database, Drive or model is touched.
 */
import { buildRosterIndex, type RosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import type {
  CatalogReader,
  EvidenceInsertRow,
  EvidenceWriter,
  IndexFileRow,
  IndexReader,
  ProjectCatalog,
  RunCounters,
  RunStore,
  T1Checkpoint,
} from '../types';

export const ACCOUNT = '11111111-1111-4111-8111-111111111111';
export const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
export const PIECE = '33333333-3333-4333-8333-333333333333';
export const TODAY = new Date(Date.UTC(2026, 10, 19));
export const WINDOW_START = '2021-11-19';

export function roster(): RosterIndex {
  return buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });
}

let seq = 0;
export function file(over: Partial<IndexFileRow> & { path: string }): IndexFileRow {
  seq += 1;
  const name = over.name ?? over.path.split(' / ').pop() ?? 'f';
  return {
    fileId: `f${String(seq).padStart(5, '0')}`,
    accountId: ACCOUNT,
    campaignId: null,
    name,
    mimeType: 'application/pdf',
    modifiedTime: new Date('2025-04-10T10:00:00Z'),
    modifiedBy: null,
    accountRooted: true,
    campaignFromPair: false,
    newerRowOtherRun: false,
    ...over,
  };
}

/** The scenario used by the run tests: every identity shape and every skip reason once. */
export function scenarioFiles(): IndexFileRow[] {
  seq = 0;
  const U2 = 'user02@agency.example';
  return [
    // strict code under a year folder: staff, period 2025
    file({
      path: 'Acme / Master / 2025 / 13. Acme | Spring [ACME55000216] / Strategy / brief.pdf',
      modifiedBy: U2,
    }),
    // same code, bracket variant folder elsewhere: still the same project
    file({
      path: 'Acme / Master / 2025 / 13. Acme | Spring [ACME55000216-01] / Strategy / b2.pdf',
      modifiedBy: 'USER03@Agency.Example',
    }),
    // unbracketed code with the known prefix: weak job code
    file({ path: 'Acme / Master / 2025 / ACME55000300 Final Files / f.pdf', modifiedBy: U2 }),
    // name-keyed project, range folder straddling the window start
    file({ path: 'Acme / Current Projects / 2019-2021 / Café Lumière / a.pdf', modifiedBy: U2 }),
    // wholly before the window
    file({ path: 'Acme / Archive / 2018 / Old Thing / f.pdf', modifiedBy: U2 }),
    // no modifier, folder entry, no project at all
    file({
      path: 'Acme / Master / 2025 / 13. Acme | Spring [ACME55000216] / x.pdf',
      modifiedBy: null,
    }),
    file({
      path: 'Acme / Master / 2025 / Folder',
      mimeType: 'application/vnd.google-apps.folder',
      modifiedBy: U2,
    }),
    file({ path: 'Acme / loose.pdf', modifiedBy: U2 }),
    // campaign attribution with campaign dates in the catalog
    file({ path: 'Acme / Brand Y / g.pdf', campaignId: CAMPAIGN, modifiedBy: U2 }),
    // external email, unknown agency email, service account address
    file({
      path: 'Acme / Master / 2025 / 13. Acme | Spring [ACME55000216] / y.pdf',
      modifiedBy: 'someone@client.example',
    }),
    file({
      path: 'Acme / Master / 2025 / 13. Acme | Spring [ACME55000216] / z.pdf',
      modifiedBy: 'former.person@agency.example',
    }),
    file({
      path: 'Acme / Master / 2025 / 13. Acme | Spring [ACME55000216] / w.pdf',
      modifiedBy: 'brand-team-mailbox@agency.example',
    }),
    // placeholder modified date
    file({
      path: 'Acme / Master / 2025 / 13. Acme | Spring [ACME55000216] / v.pdf',
      modifiedBy: U2,
      modifiedTime: new Date('1980-01-01T00:00:00Z'),
    }),
  ];
}

export const CATALOG: ProjectCatalog = {
  campaigns: [{ id: CAMPAIGN, awardedAt: '2024-02-01', liveAt: null, endsAt: '2024-09-30' }],
  pieces: [{ id: PIECE, campaignId: CAMPAIGN, jobNumber: 'ACME55000216' }],
};

export class MemoryIndex implements IndexReader {
  calls = 0;
  constructor(private readonly files: IndexFileRow[]) {}
  async readPage(accountId: string, after: string | null, limit: number): Promise<IndexFileRow[]> {
    this.calls += 1;
    return this.files
      .filter((f) => f.accountId === accountId && (after === null || f.fileId > after))
      .sort((a, b) => (a.fileId < b.fileId ? -1 : 1))
      .slice(0, limit);
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

export class MemoryRuns implements RunStore {
  runs = new Map<
    string,
    {
      status: string;
      checkpoint: T1Checkpoint | null;
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
    checkpoint: T1Checkpoint,
    counters: RunCounters,
  ): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new Error('no run');
    r.checkpoint = { ...checkpoint, doneAccountIds: [...checkpoint.doneAccountIds] };
    r.counters = counters;
  }
  async loadCheckpoint(runId: string): Promise<T1Checkpoint | null> {
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
