/**
 * Shared types of the T2 stage (Drive Activity evidence: who edited which
 * files, month by month, from `drive_edit_stats`).
 *
 * The evidence row, the closed sets and the writer port are the T1 ones
 * (src/casting/t1/types.ts, which follows gub-schemas `src/casting.ts` and
 * `prisma/schema.prisma` model Evidence since 1.26.0). They are imported, not copied.
 */
import type {
  CatalogReader,
  EvidenceInsertRow,
  EvidenceWriter,
  IndexFileRow,
  ProjectCatalog,
  RunCounters,
  RunStatus,
} from '../t1/types';

export type {
  CatalogReader,
  EvidenceInsertRow,
  EvidenceWriter,
  IndexFileRow,
  ProjectCatalog,
  RunCounters,
  RunStatus,
};

/** Written into `extractor_version`. A change of derivation rules bumps it (new rows, old rows purgeable). */
export const T2_EXTRACTOR_VERSION = 't2-activity-v1';
/**
 * `sync_runs.source` of an apply run. No CHECK on the column in the GUB
 * migrations read. The D3 record drafted in the UB epic names only T1 and T3:
 * it needs a one-line amendment for T2.
 */
export const T2_SYNC_SOURCE = 'casting_t2';

/**
 * One (file, actor, calendar month) aggregate of `drive_edit_stats`.
 *
 * A stats row is one RUN's count of one actor's edit events on one file, and
 * its `day` is the day of the RUN, not of the edit (stats.ts, ruling
 * 2026-08-15): a daily forward run dates its whole window with its own day,
 * and a seed window (30 days) is dated by its END. So `firstDay` and
 * `lastDay` bound the edit dates from above, never exactly.
 */
export interface StatsGroup {
  fileId: string;
  /** `drive_edit_stats.actor_email`: an email, a raw `people/<id>` resource, or `(unattributed)`. */
  actor: string;
  /** YYYY-MM-DD, earliest stats day of the group inside the month. */
  firstDay: string;
  /** YYYY-MM-DD, latest stats day of the group inside the month. */
  lastDay: string;
  /** Distinct stats days. */
  days: number;
  /** Sum of `edit_count` over the group. */
  edits: number;
}

/** Position inside one month: the last (file, actor) of the last completed page. */
export interface StatsCursor {
  fileId: string;
  actor: string;
}

/**
 * Reads `drive_edit_stats` of one account. Keyset-paged inside one calendar
 * month (`month` is `YYYY-MM`), ordered by (file id, actor), at most `limit`
 * groups strictly after `after`. Month windows use the (account_id, day)
 * index; a page never reads more than one month.
 */
export interface StatsReader {
  /** Earliest and latest stats day of the account, or null when it has none. */
  range(accountId: string): Promise<{ minDay: string; maxDay: string } | null>;
  readPage(
    accountId: string,
    month: string,
    after: StatsCursor | null,
    limit: number,
  ): Promise<StatsGroup[]>;
}

/** Latest index row per file id (the Drive index; file -> campaign is resolved here, at query time). */
export interface FileIndexLookup {
  lookup(accountId: string, fileIds: readonly string[]): Promise<Map<string, IndexFileRow>>;
}

/**
 * The `people_resource_map` cache: `people/<id>` -> email. A resource that is
 * absent, or present with a null email, maps to null. This port never calls
 * the People API: unresolved actors are counted and reported, never guessed.
 */
export interface PeopleMapReader {
  lookup(resources: readonly string[]): Promise<Map<string, string | null>>;
}

export interface T2Checkpoint {
  accountId: string;
  /** `YYYY-MM` in progress (every earlier month of the account is done); null = every month of the account is done. */
  month: string | null;
  /** Last (file, actor) of the last completed page of `month`; null = start of the month. */
  after: StatsCursor | null;
  /** Accounts finished before this one, in run order. */
  doneAccountIds: string[];
}

/** The `sync_runs` row of an apply run (D3). Dry-run never touches it. */
export interface T2RunStore {
  open(details: Record<string, unknown>): Promise<string>;
  /** Called after every page; must be cheap and bump the heartbeat. */
  saveProgress(runId: string, checkpoint: T2Checkpoint, counters: RunCounters): Promise<void>;
  loadCheckpoint(runId: string): Promise<T2Checkpoint | null>;
  finish(
    runId: string,
    status: Exclude<RunStatus, 'running'>,
    counters: RunCounters,
    summary: string,
  ): Promise<void>;
}
