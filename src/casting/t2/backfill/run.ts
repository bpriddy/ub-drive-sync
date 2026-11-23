/**
 * Backfill driver: plans windows, refuses overlaps, and (only with `confirm`)
 * fetches Activity window by window, oldest first, replacing each window's rows
 * under its deterministic run id, one commit per window.
 *
 * Dry-run is the default and makes NO Activity call, no People lookup, no write
 * and no `sync_runs` row; it reads only the existing run ids (for the overlap
 * check) and the account's Drive root. It prints the windows and the call
 * estimate, which is arithmetic only.
 *
 * Actors are never resolved through the People API. A `people/<id>` is mapped
 * through the `people_resource_map` cache when present; otherwise the raw
 * resource is stored, exactly as `writeRunEditStats` does for an unresolved
 * actor. They are resolved later by the existing forward code (see docs).
 *
 * Reports carry counts only: no file ids, emails or actor resources.
 */
import { OverlapError, type OverlapCheck, checkOverlap } from './overlap';
import { type CallEstimate, callEstimate, planWindows } from './windows';
import {
  type AccountReader,
  type ActivitySource,
  type BackfillCheckpoint,
  type BackfillCounters,
  type BackfillRunStore,
  type BackfillWindow,
  type EditStatsWriter,
  type ExistingStatsReader,
  type PeopleMapReader,
  BACKFILL_STAGE,
  DEFAULT_WINDOW_DAYS,
} from './types';

export interface BackfillLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface BackfillDeps {
  existing: ExistingStatsReader;
  accounts: AccountReader;
  /** Required with `confirm`. */
  activity?: ActivitySource | undefined;
  /** Required with `confirm`. */
  writer?: EditStatsWriter | undefined;
  /** Required with `confirm`. Cache only: this port never calls the People API. */
  people?: PeopleMapReader | undefined;
  /** Required with `confirm`. */
  runs?: BackfillRunStore | undefined;
  logger?: BackfillLogger | undefined;
  now?: (() => number) | undefined;
}

export interface BackfillOptions {
  accountId: string;
  from: string;
  to: string;
  windowDays?: number | undefined;
  /** false (default) = dry-run. */
  confirm: boolean;
  today: Date;
  /** Longest window an existing run can have; default 30 (the existing seed). */
  existingWindowDays?: number | undefined;
  /** Stop after the window that crosses this many ms; resumable. */
  budgetMs?: number | null | undefined;
  /** Stop after the window that brings the reported Activity calls to this many; resumable. */
  maxCalls?: number | null | undefined;
  /** Continue a paused or failed confirmed run (needs `confirm`). */
  resumeRunId?: string | null | undefined;
}

export interface BackfillReport {
  mode: 'dry-run' | 'confirm';
  status: 'success' | 'paused';
  accountId: string;
  runId: string | null;
  windowDays: number;
  windows: Array<Pick<BackfillWindow, 'index' | 'start' | 'end' | 'day' | 'runId'>>;
  estimate: CallEstimate;
  overlap: OverlapCheck;
  counters: BackfillCounters;
  actors: { unique: number; cached: number; unresolvedKeptRaw: number };
  /** Windows left when paused. */
  windowsRemaining: number;
}

const ZERO: BackfillCounters = { windowsDone: 0, events: 0, calls: 0, statRows: 0 };

export async function runBackfill(
  deps: BackfillDeps,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const now = deps.now ?? Date.now;
  const log = deps.logger;
  const confirm = options.confirm;
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (confirm && (!deps.activity || !deps.writer || !deps.people || !deps.runs)) {
    throw new Error(
      'confirm mode needs an activity source, a stats writer, a people cache and a run store',
    );
  }
  if (options.resumeRunId && !confirm) throw new Error('resume needs confirm');

  const windows = planWindows({
    accountId: options.accountId,
    from: options.from,
    to: options.to,
    windowDays,
    today: options.today,
  });
  // Hard error before anything else happens, in dry-run too.
  const overlap = checkOverlap(
    windows,
    await deps.existing.runs(options.accountId),
    options.existingWindowDays,
  );
  const root = await deps.accounts.driveRoot(options.accountId);
  if (root === null) throw new Error('the account has no Drive root folder');

  const base = {
    accountId: options.accountId,
    windowDays,
    windows: windows.map(({ index, start, end, day, runId }) => ({
      index,
      start,
      end,
      day,
      runId,
    })),
    estimate: callEstimate(windows.length),
    overlap,
  };
  if (!confirm) {
    return {
      ...base,
      mode: 'dry-run',
      status: 'success',
      runId: null,
      counters: { ...ZERO },
      actors: { unique: 0, cached: 0, unresolvedKeptRaw: 0 },
      windowsRemaining: windows.length,
    };
  }

  const runs = deps.runs as BackfillRunStore;
  const activity = deps.activity as ActivitySource;
  const writer = deps.writer as EditStatsWriter;
  const people = deps.people as PeopleMapReader;
  const startedAt = now();

  let runId: string;
  let next = 0;
  const counters: BackfillCounters = { ...ZERO };
  if (options.resumeRunId) {
    runId = options.resumeRunId;
    const cp = await runs.loadCheckpoint(runId);
    if (cp !== null) {
      if (cp.accountId !== options.accountId)
        throw new Error('resume run belongs to another account');
      next = cp.nextWindow;
    }
  } else {
    runId = await runs.open({
      stage: BACKFILL_STAGE,
      account_id: options.accountId,
      from: options.from,
      to: options.to,
      window_days: windowDays,
      windows: windows.length,
    });
  }
  counters.windowsDone = next;

  const actors = new Set<string>();
  const cachedActors = new Set<string>();
  const rawActors = new Set<string>();
  let paused = false;
  try {
    for (let i = next; i < windows.length; i++) {
      const w = windows[i] as BackfillWindow;
      const folded = await activity.foldWindow(root, w.fromIso, w.toIso);

      const resources = new Set<string>();
      for (const key of folded.tallies.keys()) {
        const actor = key.slice(key.indexOf('|') + 1);
        actors.add(actor);
        if (actor.startsWith('people/')) resources.add(actor);
      }
      const cache = resources.size > 0 ? await people.lookup([...resources]) : new Map();
      const actorEmailBy = new Map<string, string>();
      for (const r of resources) {
        const email = cache.get(r);
        if (email) {
          actorEmailBy.set(r, email);
          cachedActors.add(r);
        } else {
          actorEmailBy.set(r, r); // unresolved: the raw resource is kept, never guessed
          rawActors.add(r);
        }
      }

      const rows = await writer.replaceWindow({
        accountId: options.accountId,
        syncRunId: w.runId,
        day: w.day,
        tallies: folded.tallies,
        actorEmailBy,
      });
      counters.windowsDone = i + 1;
      counters.events += folded.events;
      counters.calls += folded.calls;
      counters.statRows += rows;
      const checkpoint: BackfillCheckpoint = { accountId: options.accountId, nextWindow: i + 1 };
      await runs.saveProgress(runId, checkpoint, counters);
      log?.info(
        { window: i + 1, of: windows.length, events: folded.events, rows },
        '[casting.t2.backfill] window committed',
      );

      const more = i + 1 < windows.length;
      const overTime = options.budgetMs != null && now() - startedAt >= options.budgetMs;
      const overCalls = options.maxCalls != null && counters.calls >= options.maxCalls;
      if (more && (overTime || overCalls)) {
        paused = true;
        break;
      }
    }
  } catch (err) {
    await runs
      .finish(runId, 'failed', counters, `failed: ${errorText(err)}`)
      .catch((e: unknown) =>
        log?.warn({ err: errorText(e) }, '[casting.t2.backfill] could not mark run failed'),
      );
    throw err;
  }

  await runs.finish(runId, paused ? 'paused' : 'success', counters, summaryLine(paused, counters));
  return {
    ...base,
    mode: 'confirm',
    status: paused ? 'paused' : 'success',
    runId,
    counters,
    actors: { unique: actors.size, cached: cachedActors.size, unresolvedKeptRaw: rawActors.size },
    windowsRemaining: windows.length - counters.windowsDone,
  };
}

const errorText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 300);

function summaryLine(paused: boolean, c: BackfillCounters): string {
  return `${paused ? 'paused' : 'success'}: windows=${c.windowsDone} events=${c.events} calls=${c.calls} rows=${c.statRows}`;
}

export { OverlapError };
