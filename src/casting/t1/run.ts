/**
 * T1 stage driver: reads the file index in keyset pages, builds the project
 * skeleton, emits weak presence evidence, and (only with `apply`) writes it.
 *
 * Passes per account, each a stream of small pages (never the whole index in
 * memory, never one huge query):
 *   1. prefix census: letter prefixes of strict job codes, which gate the
 *      unbracketed code shape;
 *   2. skeleton: per-project aggregates (period, counts), joined to the catalog;
 *   3. emit: presence rows page by page; in apply mode each page is inserted
 *      and a checkpoint is saved, so a stopped run resumes after the last page.
 *
 * Dry-run is the default and writes nothing: no rows, no `sync_runs` row.
 * Apply is idempotent: the writer inserts `ON CONFLICT (extractor_version,
 * claim_hash) DO NOTHING`, so a repeat run, or a resumed one, adds nothing new.
 *
 * Reports carry counts only: no file names, paths, emails or ids.
 */
import { jobCodePrefix, strictCodePrefix } from './job-code';
import { type SkipReason, candidateSkip, emitPresenceRow, isNotContent } from './emit';
import { usableDate, yearOf } from './period';
import { createPresenceResolver } from './presence-resolver';
import { deriveProjectContext, splitPath } from './project-context';
import { SkeletonBuilder } from './skeleton';
import type { RosterIndex } from '../identity';
import type {
  CatalogReader,
  EvidenceInsertRow,
  EvidenceWriter,
  IndexFileRow,
  IndexReader,
  RunCounters,
  RunStore,
  T1Checkpoint,
} from './types';
import { T1_EXTRACTOR_VERSION } from './types';

export const DEFAULT_CHUNK_SIZE = 2000;
/** Rows per INSERT; 22 columns each keeps a statement far below the 65535-parameter limit. */
export const INSERT_BATCH_ROWS = 500;
/** Rows are never written in dry-run, but the row type needs a run id. */
const DRY_RUN_ID = '00000000-0000-0000-0000-000000000000';

export interface T1Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface T1Deps {
  index: IndexReader;
  catalog: CatalogReader;
  roster: RosterIndex;
  /** Required in apply mode. */
  writer?: EvidenceWriter | undefined;
  /** Required in apply mode. */
  runs?: RunStore | undefined;
  logger?: T1Logger | undefined;
  /** Wall clock in ms, injectable for tests. */
  now?: (() => number) | undefined;
}

export interface T1Options {
  accountIds: readonly string[];
  /** false (default) = dry-run. */
  apply: boolean;
  chunkSize?: number | undefined;
  today: Date;
  /** YYYY-MM-DD: the sliding 5-year window start; null = no window. Recorded in the report. */
  windowStart: string | null;
  /** Stop after the page that crosses this many ms from the start; the run is resumable. */
  budgetMs?: number | null | undefined;
  /** Continue a paused or failed apply run. */
  resumeRunId?: string | null | undefined;
  /** Extra strict-code prefixes to trust for the unbracketed shape. */
  knownPrefixes?: readonly string[] | undefined;
  containerSegments?: ReadonlySet<string> | undefined;
}

export interface AccountReport {
  accountId: string;
  status: 'done' | 'paused';
  filesSeen: number;
  /** Usable modified years of the index files, for the census reconcile; `unknown` = missing or placeholder. */
  filesByModifiedYear: Record<string, number>;
  prefixes: number;
  /** How the index rows used were chosen (see PgIndexReader). */
  index: {
    accountRooted: number;
    /** Only legacy campaign-rooted rows exist for the file: newest row of any kind used. */
    legacyPathOnly: number;
    /** campaignId taken from the same-run legacy row. */
    campaignFromPair: number;
    /** A newer row of another run was left unused. */
    newerRowOtherRun: number;
  };
  projects: {
    total: number;
    byStrength: Record<string, number>;
    byPeriodBasis: Record<string, number>;
    outOfWindow: number;
    campaignConflicts: number;
  };
  skipped: Record<SkipReason, number>;
  rows: {
    emitted: number;
    byPersonKind: Record<string, number>;
    byStrength: Record<string, number>;
    /** Year of period_start; `unknown` when the period is unknown. */
    byPeriodYear: Record<string, number>;
    /** Share of rows whose modifier is not resolved to one staff row; null when no rows. */
    unresolvedShare: number | null;
  };
}

export interface T1Report {
  mode: 'dry-run' | 'apply';
  extractorVersion: string;
  windowStart: string | null;
  runId: string | null;
  status: 'success' | 'paused' | 'failed';
  counters: RunCounters;
  accounts: AccountReport[];
}

const bump = (rec: Record<string, number>, key: string, by = 1): void => {
  rec[key] = (rec[key] ?? 0) + by;
};

/** Streams the index of one account in keyset pages. */
async function* pages(
  reader: IndexReader,
  accountId: string,
  after: string | null,
  limit: number,
): AsyncGenerator<IndexFileRow[]> {
  let cursor = after;
  for (;;) {
    const page = await reader.readPage(accountId, cursor, limit);
    if (page.length === 0) return;
    yield page;
    if (page.length < limit) return;
    cursor = (page[page.length - 1] as IndexFileRow).fileId;
  }
}

function newAccountReport(accountId: string): AccountReport {
  return {
    accountId,
    status: 'done',
    filesSeen: 0,
    filesByModifiedYear: {},
    prefixes: 0,
    index: { accountRooted: 0, legacyPathOnly: 0, campaignFromPair: 0, newerRowOtherRun: 0 },
    projects: { total: 0, byStrength: {}, byPeriodBasis: {}, outOfWindow: 0, campaignConflicts: 0 },
    skipped: { not_content: 0, no_modifier: 0, no_project: 0, out_of_window: 0 },
    rows: { emitted: 0, byPersonKind: {}, byStrength: {}, byPeriodYear: {}, unresolvedShare: null },
  };
}

export async function runT1(deps: T1Deps, options: T1Options): Promise<T1Report> {
  const chunk = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunk) || chunk < 1)
    throw new RangeError('chunkSize must be a positive integer');
  const now = deps.now ?? Date.now;
  const log = deps.logger;
  const apply = options.apply;
  if (apply && (!deps.writer || !deps.runs)) {
    throw new Error('apply mode needs an evidence writer and a run store');
  }

  const startedAt = now();
  const counters: RunCounters = { filesSeen: 0, rowsInserted: 0, rowsDuplicate: 0, rowsFailed: 0 };
  const accounts: AccountReport[] = [];
  const resolve = createPresenceResolver(deps.roster);

  let runId: string | null = null;
  let resumeFrom: T1Checkpoint | null = null;
  if (apply) {
    const runs = deps.runs as RunStore;
    if (options.resumeRunId) {
      runId = options.resumeRunId;
      resumeFrom = await runs.loadCheckpoint(runId);
    } else {
      runId = await runs.open({
        stage: 'casting_t1',
        extractor_version: T1_EXTRACTOR_VERSION,
        window_start: options.windowStart,
        accounts: options.accountIds.length,
        // Read by the incremental change probe (maintain/change-probe.ts): ids only, no names.
        account_ids: [...options.accountIds],
      });
    }
  }
  const syncRunId = runId ?? DRY_RUN_ID;
  const done = new Set(resumeFrom?.doneAccountIds ?? []);
  const doneOrder = [...done];

  let status: T1Report['status'] = 'success';
  try {
    for (const accountId of options.accountIds) {
      if (done.has(accountId)) continue;
      const startAfter =
        resumeFrom !== null && resumeFrom.accountId === accountId ? resumeFrom.afterFileId : null;

      const report = newAccountReport(accountId);
      accounts.push(report);
      const catalog = await deps.catalog.load(accountId);

      // Pass 1: prefix census.
      const prefixes = new Set<string>(options.knownPrefixes ?? []);
      for (const piece of catalog.pieces) {
        const p = jobCodePrefix(piece.jobNumber);
        if (p) prefixes.add(p);
      }
      for await (const page of pages(deps.index, accountId, null, chunk)) {
        for (const f of page) {
          for (const seg of splitPath(f.path, f.name)) {
            const p = strictCodePrefix(seg);
            if (p) prefixes.add(p);
          }
        }
      }
      report.prefixes = prefixes.size;
      const ctxOptions = {
        knownPrefixes: prefixes,
        ...(options.containerSegments ? { containerSegments: options.containerSegments } : {}),
      };

      // Pass 2: skeleton.
      const builder = new SkeletonBuilder({
        today: options.today,
        windowStart: options.windowStart,
      });
      for await (const page of pages(deps.index, accountId, null, chunk)) {
        for (const f of page) {
          if (!isNotContent(f)) builder.add(f, deriveProjectContext(f, ctxOptions));
          report.filesSeen += 1;
          if (f.accountRooted) report.index.accountRooted += 1;
          else report.index.legacyPathOnly += 1;
          if (f.campaignFromPair) report.index.campaignFromPair += 1;
          if (f.newerRowOtherRun) report.index.newerRowOtherRun += 1;
          const d = usableDate(f.modifiedTime, options.today);
          bump(report.filesByModifiedYear, d === null ? 'unknown' : String(d.getUTCFullYear()));
        }
      }
      const skeleton = builder.build(catalog);
      report.projects.total = skeleton.size;
      for (const p of skeleton.values()) {
        bump(report.projects.byStrength, p.strength);
        bump(report.projects.byPeriodBasis, p.period.basis);
        if (p.outOfWindow) report.projects.outOfWindow += 1;
        if (p.campaignConflict) report.projects.campaignConflicts += 1;
      }

      // Pass 3: emit (and write).
      const resumedPass = startAfter !== null;
      const accountCounters: RunCounters = {
        filesSeen: 0,
        rowsInserted: 0,
        rowsDuplicate: 0,
        rowsFailed: 0,
      };
      let paused = false;
      for await (const page of pages(deps.index, accountId, startAfter, chunk)) {
        const rows = new Map<string, EvidenceInsertRow>();
        for (const f of page) {
          accountCounters.filesSeen += 1;
          const pre = candidateSkip(f);
          if (pre !== null) {
            report.skipped[pre] += 1;
            continue;
          }
          const ctx = deriveProjectContext(f, ctxOptions);
          const project = ctx.projectKey === null ? undefined : skeleton.get(ctx.projectKey);
          if (project === undefined) {
            report.skipped.no_project += 1;
            continue;
          }
          const res = emitPresenceRow(f, {
            accountId,
            syncRunId,
            project,
            nameKey: ctx.nameKey,
            resolve,
          });
          if (res.skipped !== undefined) {
            report.skipped[res.skipped] += 1;
            continue;
          }
          rows.set(res.row.claimHash, res.row);
          report.rows.emitted += 1;
          bump(report.rows.byPersonKind, res.row.personKind);
          bump(report.rows.byStrength, project.strength);
          const y = yearOf(project.period);
          bump(report.rows.byPeriodYear, y === null ? 'unknown' : String(y));
        }

        if (apply && rows.size > 0) {
          const writer = deps.writer as EvidenceWriter;
          const all = [...rows.values()];
          for (let i = 0; i < all.length; i += INSERT_BATCH_ROWS) {
            const part = all.slice(i, i + INSERT_BATCH_ROWS);
            const { inserted } = await writer.insertBatch(part);
            accountCounters.rowsInserted += inserted;
            accountCounters.rowsDuplicate += part.length - inserted;
          }
        }

        const last = (page[page.length - 1] as IndexFileRow).fileId;
        if (apply) {
          await (deps.runs as RunStore).saveProgress(
            runId as string,
            { accountId, afterFileId: last, doneAccountIds: doneOrder },
            sum(counters, accountCounters),
          );
        }
        if (options.budgetMs != null && now() - startedAt >= options.budgetMs) {
          // A page boundary is the only safe place to stop: the checkpoint is exact there.
          if (page.length === chunk) {
            paused = true;
            break;
          }
        }
      }

      const total = report.rows.emitted;
      report.rows.unresolvedShare =
        total === 0
          ? null
          : Math.round(
              (((report.rows.byPersonKind['external_unresolved'] ?? 0) +
                (report.rows.byPersonKind['quarantined'] ?? 0)) /
                total) *
                1000,
            ) / 1000;
      counters.filesSeen += report.filesSeen;
      counters.rowsInserted += accountCounters.rowsInserted;
      counters.rowsDuplicate += accountCounters.rowsDuplicate;
      counters.rowsFailed += accountCounters.rowsFailed;
      log?.info(
        {
          accountId,
          mode: apply ? 'apply' : 'dry-run',
          files: report.filesSeen,
          projects: report.projects.total,
          rows: report.rows.emitted,
          inserted: accountCounters.rowsInserted,
          resumed: resumedPass,
          paused,
        },
        '[casting.t1] account pass finished',
      );
      if (paused) {
        report.status = 'paused';
        status = 'paused';
        break;
      }
      doneOrder.push(accountId);
    }
  } catch (err) {
    status = 'failed';
    if (apply) {
      await (deps.runs as RunStore)
        .finish(runId as string, 'failed', counters, `failed: ${errorText(err)}`)
        .catch((e: unknown) =>
          log?.warn({ err: errorText(e) }, '[casting.t1] could not mark run failed'),
        );
    }
    throw err;
  }

  if (apply) {
    await (deps.runs as RunStore).finish(
      runId as string,
      status === 'paused' ? 'paused' : 'success',
      counters,
      summaryLine(status, counters),
    );
  }
  return {
    mode: apply ? 'apply' : 'dry-run',
    extractorVersion: T1_EXTRACTOR_VERSION,
    windowStart: options.windowStart,
    runId,
    status,
    counters,
    accounts,
  };
}

function sum(total: RunCounters, part: RunCounters): RunCounters {
  return {
    filesSeen: total.filesSeen + part.filesSeen,
    rowsInserted: total.rowsInserted + part.rowsInserted,
    rowsDuplicate: total.rowsDuplicate + part.rowsDuplicate,
    rowsFailed: total.rowsFailed + part.rowsFailed,
  };
}

const errorText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 300);

function summaryLine(status: T1Report['status'], c: RunCounters): string {
  return `${status}: files=${c.filesSeen} inserted=${c.rowsInserted} duplicate=${c.rowsDuplicate} failed=${c.rowsFailed}`;
}
