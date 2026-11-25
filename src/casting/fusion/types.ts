/**
 * Shared types of the fusion stage (Layer 1 `evidence` -> the staff work join
 * tables `staff_accounts` / `staff_campaigns`, gub-schemas 1.29.0).
 *
 * A claim (ExperienceDraft, FusedClaim) is the formula's unit and is no longer
 * stored: rollup.ts turns the claims of an account into the rows of the two
 * tables (StaffAccountDraft, StaffCampaignDraft).
 */
import type {
  EvidenceSource,
  PersonKind,
  RoleNorm,
  Seniority,
  StaffWorkWithheldReason,
  WithheldReason,
} from './vocab';
import type { Tier } from './constants';

/**
 * One Layer 1 row as the fusion reads it. Only the columns the formula needs:
 * names, quotes and raw role text never enter this stage.
 */
export interface FusionEvidence {
  /** Row id; links and the stable sort use it. */
  id: string;
  staffId: string | null;
  personKind: PersonKind;
  accountId: string;
  jobNumber: string | null;
  campaignId: string | null;
  pieceId: string | null;
  roleNorm: RoleNorm | null;
  seniority: Seniority | null;
  /** YYYY-MM-DD */
  periodStart: string | null;
  periodEnd: string | null;
  source: EvidenceSource;
  fileId: string;
  /** Read for T1 only: `name:<key>` is the project key of a name-keyed project. */
  location: string | null;
  confidence: number;
  /** Presence flags only (T3 row strength): the quote and the raw role text never enter this stage. */
  hasQuote: boolean;
  hasRole: boolean;
  withheldReason: WithheldReason | null;
  extractorVersion: string;
  /** `sync_runs.id` of the load run that wrote the row. */
  syncRunId: string;
  /** Start of that run (`sync_runs.started_at`, ISO-8601 UTC, fixed width so text order is time order). */
  loadedAt: string;
}

/** An account the catalog knows. Fusion needs only that it exists. */
export interface FusionAccount {
  id: string;
}

export interface FusionCampaign {
  id: string;
  accountId: string;
  /** `campaigns.status`: pitch, awarded, in_progress, live, paused, ended, lost. */
  status: string | null;
  awardedAt: string | null;
  liveAt: string | null;
  endsAt: string | null;
}

export interface FusionPiece {
  id: string;
  campaignId: string;
  jobNumber: string | null;
}

export interface FusionStaff {
  staffId: string;
  /** Employment start (YYYY-MM-DD); null = unknown, the window check is skipped. */
  startedAt: string | null;
  /** Active, a person, and not ended as of the run date. Decided by the caller; the stage never reads the clock. */
  isCurrent: boolean;
}

export interface FusionInput {
  evidence: readonly FusionEvidence[];
  campaigns: readonly FusionCampaign[];
  pieces: readonly FusionPiece[];
  staff: readonly FusionStaff[];
  /**
   * First day with `drive_edit_stats` per account (the T2 horizon of the account).
   * Used by the proxy metrics only. Absent or null = no T2 data for the account.
   */
  activityStartByAccount?: ReadonlyMap<string, string | null> | undefined;
}

/** `not_validated`: no T2 evidence supports the claim (older years, or no activity data). */
export type ValidationLabel = 'not_validated' | 'activity_checked';

/** One claim (staff, project, role): the formula's unit, rolled up before storage (rollup.ts). */
export interface ExperienceDraft {
  id: string;
  staffId: string;
  accountId: string;
  jobNumber: string | null;
  campaignId: string | null;
  pieceId: string | null;
  roleNorm: RoleNorm | null;
  seniority: Seniority | null;
  periodStart: string | null;
  periodEnd: string | null;
  confidence: number;
  withheldReason: WithheldReason | null;
  fusionVersion: string;
  experienceHash: string;
}

/** A derived claim with everything that explains it. Only `row` is persisted. */
export interface FusedClaim {
  row: ExperienceDraft;
  /** Canonical project key (not a column): hashing and grouping. */
  projectKey: string;
  /** Distinct tiers with a usable row behind the claim. */
  tiers: Tier[];
  /** Score of each present tier, after the pitch factor, before the combination. */
  tierScores: Partial<Record<Tier, number>>;
  /** 1 or LOST_PITCH_FACTOR. */
  pitchFactor: number;
  /** Layer 1 row ids behind the claim, sorted. */
  evidenceIds: string[];
  validation: ValidationLabel;
}

export interface TierMetrics {
  rows: number;
  staff: number;
  externalUnresolved: number;
  quarantined: number;
  /** Claims with a usable row of this tier. */
  claims: number;
  /** Served claims with a usable row of this tier. */
  servedClaims: number;
}

export interface FusionMetrics {
  evidenceRows: number;
  duplicateIds: number;
  /** Rows dropped because a newer extractor_version covers the same (source, file). */
  superseded: number;
  /** T3 rows dropped because a newer load of the same file exists (an older content version). */
  olderContentVersion: number;
  /** Staff rows that never became a claim, by reason. */
  staffRowsDropped: { notCurrent: number; unknownStaff: number; withheldStaffRow: number };
  byTier: Record<Tier, TierMetrics>;
  claims: {
    /** Claims formed, stored or not. */
    formed: number;
    stored: number;
    /** Presence-only claims (no content row), not stored. */
    presenceOnlyNotStored: number;
    served: number;
    withheld: { conflicting: number; unconfirmed: number };
    /** Stored claims with no project reference at all (never served). */
    projectless: number;
    /** Served claims whose evidence spans at least SERVE_MIN_TIERS tiers (must equal `served`). */
    servedWithMinTiers: number;
  };
  /** Role claims with a content row: share backed by >= 2 distinct files. Null when none. */
  crossDocumentAgreement: { claims: number; withTwoFiles: number; share: number | null };
  /**
   * T2 agreement, LOWER-BOUND proxy, only for claims inside the account's activity
   * horizon: share of content-backed claims that also have T2 evidence. Null when
   * no claim is inside a horizon. Says nothing about older years.
   */
  t2Agreement: { claims: number; withT2: number; share: number | null };
  /** Projects seen in Layer 1 per `<account>|<period year or unknown>`. */
  coverage: Record<
    string,
    { projects: number; withResolvedPerson: number; withServedClaim: number }
  >;
  /** Served claims per period year (or `unknown`) and validation label. Older years: `not_validated`. */
  servedByYear: Record<string, { activity_checked: number; not_validated: number }>;
}

export interface FusionOutput {
  /** Stored claims, sorted by experience hash. */
  claims: FusedClaim[];
  metrics: FusionMetrics;
}

// ── ports ───────────────────────────────────────────────────────────────────

/** Layer 1 of one account, keyset-paged by evidence id, strictly after `afterId`. */
export interface EvidenceReader {
  readPage(accountId: string, afterId: string | null, limit: number): Promise<FusionEvidence[]>;
}

export interface FusionCatalog {
  account: FusionAccount | null;
  campaigns: FusionCampaign[];
  pieces: FusionPiece[];
}

export interface CatalogLoader {
  load(accountId: string): Promise<FusionCatalog>;
}

export interface StaffLoader {
  /** All staff; `today` (YYYY-MM-DD) decides `isCurrent`. */
  load(today: string): Promise<FusionStaff[]>;
}

export interface ActivityHorizon {
  /** First `drive_edit_stats` day of the account, or null. */
  startOf(accountId: string): Promise<string | null>;
}

/** The columns both staff work tables share, as this stage writes them (source drive_casting). */
interface StaffWorkDraftBase {
  id: string;
  staffId: string;
  roleNorm: RoleNorm | null;
  seniority: Seniority | null;
  periodStart: string | null;
  periodEnd: string | null;
  source: 'drive_casting';
  confidence: number;
  tiers: number;
  activityChecked: boolean;
  withheldReason: StaffWorkWithheldReason | null;
  buildVersion: string;
  rowHash: string;
  /** Layer 1 rows behind the row (its *_evidence_links), sorted. */
  evidenceIds: string[];
}

/** A `staff_accounts` row: a person on an account. */
export interface StaffAccountDraft extends StaffWorkDraftBase {
  accountId: string;
}

/** A `staff_campaigns` row: a person on a campaign, optionally a piece. */
export interface StaffCampaignDraft extends StaffWorkDraftBase {
  campaignId: string;
  pieceId: string | null;
  jobNumber: string | null;
}

export interface StaffWorkRollup {
  accounts: StaffAccountDraft[];
  campaigns: StaffCampaignDraft[];
}

export interface WriteCounts {
  /** drive_casting `staff_accounts` rows of the account removed (every build version). */
  deletedAccounts: number;
  /** drive_casting `staff_campaigns` rows of the account's campaigns removed. */
  deletedCampaigns: number;
  insertedAccounts: number;
  insertedCampaigns: number;
  links: number;
}

/**
 * Replaces the drive_casting staff work rows of one account in ONE transaction:
 * delete them (every build version; links cascade), insert the new rows and
 * links. Never touches a `manual` row. A rebuildable projection; only Layer 1 is
 * append-only.
 */
export interface StaffWorkWriter {
  replaceAccount(args: {
    accountId: string;
    buildVersion: string;
    syncRunId: string;
    rollup: StaffWorkRollup;
  }): Promise<WriteCounts>;
}

export type RunStatus = 'success' | 'failed';

export interface RunCounts extends WriteCounts {
  /** Layer 1 rows read. */
  evidenceRows: number;
}

/** The `sync_runs` row of an apply run (D3). Dry-run never touches it. */
export interface FusionRunStore {
  open(details: Record<string, unknown>): Promise<string>;
  finish(runId: string, status: RunStatus, counts: RunCounts, summary: string): Promise<void>;
}
