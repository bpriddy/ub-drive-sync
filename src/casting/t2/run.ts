/**
 * T2 stage driver: reads `drive_edit_stats` month by month in keyset pages,
 * resolves each (file, actor, month) group to a project and a person, emits
 * weak activity evidence, and (only with `apply`) writes it.
 *
 * Per account: months from the first stats month (or the window start) to the
 * last CLOSED month; inside a month, pages ordered by (file, actor). Nothing
 * larger than one page is ever in memory, and a query never spans a month.
 *
 * Dry-run is the default and writes nothing: no rows, no `sync_runs` row.
 * Apply is idempotent: the writer inserts `ON CONFLICT (extractor_version,
 * claim_hash) DO NOTHING`, so a repeat run, or a resumed one, adds nothing.
 * A checkpoint (month, last group) is saved after every page, so a stopped
 * run resumes exactly.
 *
 * Reports carry counts only: no file names, ids, emails or actor resources.
 * The year in a report is the year of the stats month.
 */
import { resolveIdentity, type RosterIndex } from '../identity';
import { classifyActor, isPeopleResource, type ActorClass } from './actors';
import { emitActivityRow } from './emit';
import { monthOfDay, monthsBetween, previousMonth } from './months';
import { createProjectResolver } from './project';
import type {
  CatalogReader,
  EvidenceInsertRow,
  EvidenceWriter,
  FileIndexLookup,
  IndexFileRow,
  PeopleMapReader,
  RunCounters,
  StatsCursor,
  StatsGroup,
  StatsReader,
  T2Checkpoint,
  T2RunStore,
} from './types';
import { T2_EXTRACTOR_VERSION } from './types';

export const DEFAULT_CHUNK_SIZE = 2000;
/** Rows per INSERT; 22 columns each keeps a statement far below the 65535-parameter limit. */
export const INSERT_BATCH_ROWS = 500;
/** Rows are never written in dry-run, but the row type needs a run id. */
const DRY_RUN_ID = '00000000-0000-0000-0000-000000000000';

const NOT_CONTENT_MIME = new Set([
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.shortcut',
]);

export interface T2Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface T2Deps {
  stats: StatsReader;
  index: FileIndexLookup;
  people: PeopleMapReader;
  catalog: CatalogReader;
  roster: RosterIndex;
  /** Required in apply mode. */
  writer?: EvidenceWriter | undefined;
  /** Required in apply mode. */
  runs?: T2RunStore | undefined;
  logger?: T2Logger | undefined;
  /** Wall clock in ms, injectable for tests. */
  now?: (() => number) | undefined;
}

export interface T2Options {
  accountIds: readonly string[];
  /** false (default) = dry-run. */
  apply: boolean;
  chunkSize?: number | undefined;
  /** The run date: months from its own month on are open and not emitted. */
  today: Date;
  /** YYYY-MM-DD: months wholly before it are skipped; null = no window. Recorded in the report. */
  windowStart: string | null;
  /** Stop after the page that crosses this many ms from the start; the run is resumable. */
  budgetMs?: number | null | undefined;
  /** Continue a paused or failed apply run. */
  resumeRunId?: string | null | undefined;
  /** Recorded in the run details and the report (the S3 option the roster was built with). */
  unknownStartDates?: readonly string[] | undefined;
}

export type SkipReason =
  | 'actor_unresolved'
  | 'actor_unattributed'
  | 'actor_unrecognised'
  | 'file_not_in_index'
  | 'not_content'
  | 'no_project';

export interface YearReport {
  /** (file, actor, month) groups read. */
  groups: number;
  /** Sum of edit counts of those groups. */
  edits: number;
  byActorClass: Record<ActorClass, number>;
  /** Edits of groups whose actor is a `people/<id>` the cache cannot resolve. */
  editsPeopleUnresolved: number;
  /** Edits of the synthetic `(unattributed)` actor (system or anonymous). */
  editsUnattributed: number;
  /** Distinct actors read (emails and resources together). */
  uniqueActors: number;
  /** Distinct `people/<id>` actors the cache cannot resolve. */
  uniquePeopleUnresolved: number;
  /** Distinct `people/<id>` actors the cache resolved. */
  uniquePeopleCached: number;
  skipped: Record<SkipReason, number>;
  rows: {
    emitted: number;
    /** Groups that produced a claim already emitted in the same page (two actors, one email). */
    mergedClaims: number;
    byPersonKind: Record<string, number>;
    /** Emitted rows whose email is in the roster but failed the employment-window gate. */
    windowGate: number;
  };
  /** people_unresolved groups / groups with an attributable actor (all but `unattributed`); null if none. */
  peopleUnresolvedShare: number | null;
  /** Same share, weighted by edit count. */
  peopleUnresolvedEditShare: number | null;
  /** (external_unresolved + quarantined) / emitted; null if none. */
  notStaffShareOfEmitted: number | null;
}

export interface AccountReport {
  accountId: string;
  status: 'done' | 'paused';
  /** First and last closed month this run covered (null when the account has nothing in range). */
  months: { first: string; last: string } | null;
  byYear: Record<string, YearReport>;
}

export interface T2Report {
  mode: 'dry-run' | 'apply';
  extractorVersion: string;
  windowStart: string | null;
  /** Dates the roster treats as "start unknown" (window gate off for those rows). */
  unknownStartDates: readonly string[];
  runId: string | null;
  status: 'success' | 'paused' | 'failed';
  counters: RunCounters;
  accounts: AccountReport[];
}

interface YearAcc extends YearReport {
  actors: Set<string>;
  peopleUnresolved: Set<string>;
  peopleCached: Set<string>;
}

const bump = (rec: Record<string, number>, key: string, by = 1): void => {
  rec[key] = (rec[key] ?? 0) + by;
};

function newYear(): YearAcc {
  return {
    groups: 0,
    edits: 0,
    byActorClass: {
      email: 0,
      people_cached: 0,
      people_unresolved: 0,
      unattributed: 0,
      unrecognised: 0,
    },
    editsPeopleUnresolved: 0,
    editsUnattributed: 0,
    uniqueActors: 0,
    uniquePeopleUnresolved: 0,
    uniquePeopleCached: 0,
    skipped: {
      actor_unresolved: 0,
      actor_unattributed: 0,
      actor_unrecognised: 0,
      file_not_in_index: 0,
      not_content: 0,
      no_project: 0,
    },
    rows: { emitted: 0, mergedClaims: 0, byPersonKind: {}, windowGate: 0 },
    peopleUnresolvedShare: null,
    peopleUnresolvedEditShare: null,
    notStaffShareOfEmitted: null,
    actors: new Set(),
    peopleUnresolved: new Set(),
    peopleCached: new Set(),
  };
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function finalize(y: YearAcc): YearReport {
  const { actors, peopleUnresolved, peopleCached, ...rest } = y;
  const attributable = rest.groups - rest.byActorClass.unattributed;
  const attributableEdits = rest.edits - rest.editsUnattributed;
  return {
    ...rest,
    uniqueActors: actors.size,
    uniquePeopleUnresolved: peopleUnresolved.size,
    uniquePeopleCached: peopleCached.size,
    peopleUnresolvedShare:
      attributable === 0 ? null : round3(rest.byActorClass.people_unresolved / attributable),
    peopleUnresolvedEditShare:
      attributableEdits <= 0 ? null : round3(rest.editsPeopleUnresolved / attributableEdits),
    notStaffShareOfEmitted:
      rest.rows.emitted === 0
        ? null
        : round3(
            ((rest.rows.byPersonKind['external_unresolved'] ?? 0) +
              (rest.rows.byPersonKind['quarantined'] ?? 0)) /
              rest.rows.emitted,
          ),
  };
}

/** The last month that is closed on `today` (the month before today's month). */
export function lastClosedMonth(today: Date): string {
  const m = today.toISOString().slice(0, 7);
  return previousMonth(m);
}

export async function runT2(deps: T2Deps, options: T2Options): Promise<T2Report> {
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
  const closed = lastClosedMonth(options.today);
  const windowMonth = options.windowStart === null ? null : monthOfDay(options.windowStart);
  const unknownStartDates = [...(options.unknownStartDates ?? [])];

  let runId: string | null = null;
  let resumeFrom: T2Checkpoint | null = null;
  if (apply) {
    const runs = deps.runs as T2RunStore;
    if (options.resumeRunId) {
      runId = options.resumeRunId;
      resumeFrom = await runs.loadCheckpoint(runId);
    } else {
      runId = await runs.open({
        stage: 'casting_t2',
        extractor_version: T2_EXTRACTOR_VERSION,
        window_start: options.windowStart,
        last_closed_month: closed,
        unknown_start_dates: unknownStartDates,
        accounts: options.accountIds.length,
      });
    }
  }
  const syncRunId = runId ?? DRY_RUN_ID;
  const done = new Set(resumeFrom?.doneAccountIds ?? []);
  const doneOrder = [...done];

  let status: T2Report['status'] = 'success';
  try {
    for (const accountId of options.accountIds) {
      if (done.has(accountId)) continue;
      const resume = resumeFrom !== null && resumeFrom.accountId === accountId ? resumeFrom : null;

      const years = new Map<string, YearAcc>();
      const yearOf = (month: string): YearAcc => {
        const y = month.slice(0, 4);
        let acc = years.get(y);
        if (acc === undefined) {
          acc = newYear();
          years.set(y, acc);
        }
        return acc;
      };
      const report: AccountReport = { accountId, status: 'done', months: null, byYear: {} };
      accounts.push(report);

      const range = await deps.stats.range(accountId);
      let months: string[] = [];
      if (range !== null) {
        const first =
          windowMonth !== null && windowMonth > monthOfDay(range.minDay)
            ? windowMonth
            : monthOfDay(range.minDay);
        months = monthsBetween(first, closed);
        // A null checkpoint month means every month of this account is already done.
        if (resume !== null) {
          const from = resume.month;
          months = from === null ? [] : months.filter((m) => m >= from);
        }
      }
      if (months.length > 0) {
        report.months = {
          first: months[0] as string,
          last: months[months.length - 1] as string,
        };
      }

      const catalog = await deps.catalog.load(accountId);
      const projects = createProjectResolver(catalog);
      const accountCounters: RunCounters = {
        filesSeen: 0,
        rowsInserted: 0,
        rowsDuplicate: 0,
        rowsFailed: 0,
      };
      let paused = false;

      monthLoop: for (let mi = 0; mi < months.length; mi++) {
        const month = months[mi] as string;
        let after: StatsCursor | null =
          resume !== null && resume.month === month ? resume.after : null;

        for (;;) {
          const page: StatsGroup[] = await deps.stats.readPage(accountId, month, after, chunk);
          if (page.length === 0) break;
          const acc = yearOf(month);

          // One lookup of the files and one of the people resources per page.
          const fileIds = [...new Set(page.map((g) => g.fileId))];
          const resources = [
            ...new Set(page.map((g) => g.actor.trim()).filter((a) => isPeopleResource(a))),
          ];
          const files = await deps.index.lookup(accountId, fileIds);
          const peopleCache =
            resources.length > 0
              ? await deps.people.lookup(resources)
              : new Map<string, string | null>();

          const rows = new Map<string, EvidenceInsertRow>();
          for (const g of page) {
            acc.groups += 1;
            acc.edits += g.edits;
            const actor = classifyActor(g.actor, peopleCache);
            acc.byActorClass[actor.class] += 1;
            acc.actors.add(g.actor.trim());
            if (actor.class === 'people_unresolved') {
              acc.editsPeopleUnresolved += g.edits;
              acc.peopleUnresolved.add(g.actor.trim());
            } else if (actor.class === 'people_cached') {
              acc.peopleCached.add(g.actor.trim());
            } else if (actor.class === 'unattributed') {
              acc.editsUnattributed += g.edits;
            }

            if (actor.email === null) {
              acc.skipped[
                actor.class === 'unattributed'
                  ? 'actor_unattributed'
                  : actor.class === 'unrecognised'
                    ? 'actor_unrecognised'
                    : 'actor_unresolved'
              ] += 1;
              continue;
            }
            const file: IndexFileRow | undefined = files.get(g.fileId);
            if (file === undefined) {
              acc.skipped.file_not_in_index += 1;
              continue;
            }
            if (file.mimeType !== null && NOT_CONTENT_MIME.has(file.mimeType)) {
              acc.skipped.not_content += 1;
              continue;
            }
            const project = projects.resolve(file);
            if (project === null) {
              acc.skipped.no_project += 1;
              continue;
            }
            const resolution = resolveIdentity(deps.roster, {
              rawName: '',
              rawEmail: actor.email,
              evidenceDate: g.lastDay,
            });
            const row = emitActivityRow(g, {
              accountId,
              syncRunId,
              month,
              project,
              email: actor.email,
              resolution,
            });
            if (rows.has(row.claimHash)) {
              acc.rows.mergedClaims += 1;
              continue;
            }
            rows.set(row.claimHash, row);
            acc.rows.emitted += 1;
            bump(acc.rows.byPersonKind, row.personKind);
            if (resolution.personKind === 'quarantined' && resolution.reason === 'window_gate') {
              acc.rows.windowGate += 1;
            }
          }
          accountCounters.filesSeen += page.length;

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

          const lastGroup = page[page.length - 1] as StatsGroup;
          const monthDone = page.length < chunk;
          after = { fileId: lastGroup.fileId, actor: lastGroup.actor };
          const nextMonthKey = months[mi + 1] ?? null;
          if (apply) {
            // A finished month moves the checkpoint to the start of the next one.
            const checkpoint: T2Checkpoint = monthDone
              ? { accountId, month: nextMonthKey, after: null, doneAccountIds: doneOrder }
              : { accountId, month, after, doneAccountIds: doneOrder };
            await (deps.runs as T2RunStore).saveProgress(
              runId as string,
              checkpoint,
              sum(counters, accountCounters),
            );
          }
          const more = !monthDone || nextMonthKey !== null;
          if (options.budgetMs != null && now() - startedAt >= options.budgetMs && more) {
            paused = true;
            break monthLoop;
          }
          if (monthDone) break;
        }
      }

      for (const [y, acc] of years) report.byYear[y] = finalize(acc);
      counters.filesSeen += accountCounters.filesSeen;
      counters.rowsInserted += accountCounters.rowsInserted;
      counters.rowsDuplicate += accountCounters.rowsDuplicate;
      counters.rowsFailed += accountCounters.rowsFailed;
      log?.info(
        {
          accountId,
          mode: apply ? 'apply' : 'dry-run',
          groups: accountCounters.filesSeen,
          inserted: accountCounters.rowsInserted,
          resumed: resume !== null,
          paused,
        },
        '[casting.t2] account pass finished',
      );
      if (paused) {
        report.status = 'paused';
        status = 'paused';
        break;
      }
      doneOrder.push(accountId);
    }
  } catch (err) {
    if (apply) {
      await (deps.runs as T2RunStore)
        .finish(runId as string, 'failed', counters, `failed: ${errorText(err)}`)
        .catch((e: unknown) =>
          log?.warn({ err: errorText(e) }, '[casting.t2] could not mark run failed'),
        );
    }
    throw err;
  }

  if (apply) {
    await (deps.runs as T2RunStore).finish(
      runId as string,
      status === 'paused' ? 'paused' : 'success',
      counters,
      summaryLine(status, counters),
    );
  }
  return {
    mode: apply ? 'apply' : 'dry-run',
    extractorVersion: T2_EXTRACTOR_VERSION,
    windowStart: options.windowStart,
    unknownStartDates,
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

/** `filesSeen` carries the number of stats groups read (the `sync_runs.total_scanned` column). */
function summaryLine(status: T2Report['status'], c: RunCounters): string {
  return `${status}: groups=${c.filesSeen} inserted=${c.rowsInserted} duplicate=${c.rowsDuplicate} failed=${c.rowsFailed}`;
}
