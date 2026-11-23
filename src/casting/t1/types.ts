/**
 * Shared types of the T1 stage (Drive folder / job skeleton and file-metadata
 * presence evidence for the casting staffing dataset).
 *
 * The evidence row mirrors the Layer 1 contract in gub-schemas `src/casting.ts`
 * and `prisma/schema.prisma` (model Evidence). The closed sets and the quote
 * limit are re-exported from '@anomaly-technology/gub-schemas' (since 1.26.0);
 * the insert-row shape below is repo-local (camelCase, writer-owned columns).
 */
import {
  EVIDENCE_QUOTE_MAX_CHARS,
  EVIDENCE_SOURCES,
  PERSON_KINDS,
  WITHHELD_REASONS,
  type EvidenceSource,
  type PersonKind,
  type WithheldReason,
} from '@anomaly-technology/gub-schemas';

export { EVIDENCE_QUOTE_MAX_CHARS, EVIDENCE_SOURCES, PERSON_KINDS, WITHHELD_REASONS };
export type { EvidenceSource, PersonKind, WithheldReason };

/** Written into `extractor_version`. A change of derivation rules bumps it (new rows, old rows purgeable). */
export const T1_EXTRACTOR_VERSION = 't1-metadata-v2';
/** `sync_runs.source` of an apply run. [VERIFY: no CHECK on sync_runs.source in the GUB migrations read.] */
export const T1_SYNC_SOURCE = 'casting_t1';

/** One Layer 1 row as the writer inserts it (`id` and `created_at` are the writer's). */
export interface EvidenceInsertRow {
  staffId: string | null;
  rawName: string;
  personKind: PersonKind;
  accountId: string;
  jobNumber: string | null;
  campaignId: string | null;
  pieceId: string | null;
  roleRaw: string | null;
  roleNorm: string | null;
  seniority: string | null;
  /** YYYY-MM-DD */
  periodStart: string | null;
  /** YYYY-MM-DD */
  periodEnd: string | null;
  source: EvidenceSource;
  fileId: string;
  location: string | null;
  quote: string | null;
  confidence: number;
  withheldReason: WithheldReason | null;
  extractorVersion: string;
  syncRunId: string;
  claimHash: string;
}

/** The latest `drive_file_snapshots` row of one file, only the columns T1 reads. */
export interface IndexFileRow {
  fileId: string;
  accountId: string;
  /** v2: folder attribution of the file; v1: set by campaign scans only. */
  campaignId: string | null;
  name: string;
  mimeType: string | null;
  /** ` / `-separated breadcrumb; the last segment is normally the file name. */
  path: string | null;
  modifiedTime: Date | null;
  /** Email of Drive's lastModifyingUser; null on a large share of files (rises with age). */
  modifiedBy: string | null;
  /**
   * false = the file has only legacy v1 campaign-scan rows (path rooted at the
   * campaign's name, not the real folders): the row used is the newest of any
   * kind and its path is of poor value. See PgIndexReader.
   */
  accountRooted: boolean;
  /** campaignId was taken from the newest row of the same v1 run (the account row has none). */
  campaignFromPair: boolean;
  /** A newer row of ANOTHER run exists that was not used (its modifier and path are ignored). */
  newerRowOtherRun: boolean;
}

/**
 * Reads the file index. Implementations return ONE row per file of one
 * account (the newest account-rooted row, see PgIndexReader), ordered by file
 * id, strictly after `afterFileId`, at most `limit` rows. Keyset paging keeps every query small (80k-file ceiling, 300 s cap).
 */
export interface IndexReader {
  readPage(accountId: string, afterFileId: string | null, limit: number): Promise<IndexFileRow[]>;
}

export interface CampaignInfo {
  id: string;
  /** YYYY-MM-DD or null */
  awardedAt: string | null;
  liveAt: string | null;
  endsAt: string | null;
}

export interface PieceInfo {
  id: string;
  campaignId: string;
  /** Unique across pieces. */
  jobNumber: string;
}

/** The accounts database side of the skeleton: campaigns and pieces of one account. */
export interface ProjectCatalog {
  campaigns: CampaignInfo[];
  pieces: PieceInfo[];
}

export interface CatalogReader {
  load(accountId: string): Promise<ProjectCatalog>;
}

/** Inserts Layer 1 rows. Must be a no-op for a row whose (extractor_version, claim_hash) exists. */
export interface EvidenceWriter {
  insertBatch(rows: readonly EvidenceInsertRow[]): Promise<{ inserted: number }>;
}

export interface T1Checkpoint {
  accountId: string;
  /** Last file id of the last completed emit page; the next page starts after it. */
  afterFileId: string | null;
  /** Accounts finished before this one, in run order. */
  doneAccountIds: string[];
}

export interface RunCounters {
  filesSeen: number;
  rowsInserted: number;
  rowsDuplicate: number;
  rowsFailed: number;
}

export type RunStatus = 'running' | 'success' | 'failed' | 'paused';

/** The `sync_runs` row of an apply run (D3). Dry-run never touches it. */
export interface RunStore {
  open(details: Record<string, unknown>): Promise<string>;
  /** Called after every emit page; must be cheap and bump the heartbeat. */
  saveProgress(runId: string, checkpoint: T1Checkpoint, counters: RunCounters): Promise<void>;
  loadCheckpoint(runId: string): Promise<T1Checkpoint | null>;
  finish(
    runId: string,
    status: Exclude<RunStatus, 'running'>,
    counters: RunCounters,
    summary: string,
  ): Promise<void>;
}
