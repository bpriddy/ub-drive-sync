/**
 * Ports and shapes of the Activity edit-stats backfill (ops step of the T2
 * stage). Everything that touches Drive Activity or the database is a port, so
 * the core never constructs a real client: the real wiring lives in
 * `real-ports.ts` (Activity, stats writer) and `pg-adapters.ts` (database),
 * and only `main.ts` reaches them.
 */
import type { PeopleMapReader } from '../types';

export type { PeopleMapReader };

/** `sync_runs.source` of a confirmed backfill run. Needs a line in the D3 record. */
export const BACKFILL_SYNC_SOURCE = 'drive_edit_stats_backfill';
/** Written into `sync_runs.details.stage`. */
export const BACKFILL_STAGE = 'edit_stats_backfill';
/** Activity API `pageSize` used by the forward client (src/forward/activity.ts). */
export const ACTIVITY_PAGE_SIZE = 500;
/** The existing seed windows are 30 days; a longer backfill window is refused. */
export const MAX_WINDOW_DAYS = 30;
export const DEFAULT_WINDOW_DAYS = 30;
/** Refuses plans larger than this many windows (a typo guard, not a limit of the design). */
export const MAX_WINDOWS = 4000;

/** One backfill window: events in (from, to], rows dated by the window END. */
export interface BackfillWindow {
  /** 0-based, oldest first. */
  index: number;
  /** YYYY-MM-DD, exclusive start of the window (00:00:00Z). */
  start: string;
  /** YYYY-MM-DD, inclusive end of the window (00:00:00Z); also the `day` of its stats rows. */
  end: string;
  fromIso: string;
  toIso: string;
  /** `drive_edit_stats.day` of the window's rows: the window end (run-date framing). */
  day: string;
  /** Deterministic `sync_run_id` of the window's rows. */
  runId: string;
}

/** One run id of `drive_edit_stats` for an account (the table has no window bounds). */
export interface ExistingRun {
  syncRunId: string;
  /** YYYY-MM-DD, earliest `day` of the run's rows. */
  minDay: string;
  /** YYYY-MM-DD, latest `day` of the run's rows. */
  maxDay: string;
  rows: number;
}

export interface ExistingStatsReader {
  runs(accountId: string): Promise<ExistingRun[]>;
}

export interface AccountReader {
  /** The account's Drive root folder id, or null when the account has none. */
  driveRoot(accountId: string): Promise<string | null>;
}

export interface FoldedWindow {
  /** `${fileId}|${actorResource}` -> edit count (the shape `foldEvents` returns). */
  tallies: ReadonlyMap<string, number>;
  /** Activity events seen in the window (normalised, one per action x target). */
  events: number;
  /** Activity API calls the fetch made (a lower-bound proxy in the real adapter, see real-ports.ts). */
  calls: number;
}

/** Fetches and folds Drive Activity for one window. The real one calls the API; tests use a fake. */
export interface ActivitySource {
  foldWindow(rootFolderId: string, fromIso: string, toIso: string): Promise<FoldedWindow>;
}

/**
 * Replaces ALL rows of one run id with the window's tallies, in one transaction
 * (the behaviour of `writeRunEditStats`: delete by run id, then create). A retry
 * with the same run id therefore replaces only its own rows.
 */
export interface EditStatsWriter {
  replaceWindow(args: {
    accountId: string;
    syncRunId: string;
    /** YYYY-MM-DD */
    day: string;
    tallies: ReadonlyMap<string, number>;
    /** actorResource -> email, or the raw resource when unresolved. */
    actorEmailBy: ReadonlyMap<string, string>;
  }): Promise<number>;
}

export interface BackfillCounters {
  windowsDone: number;
  events: number;
  calls: number;
  statRows: number;
}

export interface BackfillCheckpoint {
  accountId: string;
  /** Index of the next window to process; every earlier window is committed. */
  nextWindow: number;
}

export interface BackfillRunStore {
  open(details: Record<string, unknown>): Promise<string>;
  saveProgress(runId: string, checkpoint: BackfillCheckpoint, c: BackfillCounters): Promise<void>;
  loadCheckpoint(runId: string): Promise<BackfillCheckpoint | null>;
  finish(
    runId: string,
    status: 'success' | 'failed' | 'paused',
    c: BackfillCounters,
    summary: string,
  ): Promise<void>;
}
