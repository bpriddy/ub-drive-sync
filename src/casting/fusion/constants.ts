/**
 * The fusion formula's version and every named constant it uses.
 *
 * NOTHING HERE IS CALIBRATED. There is no ground truth (O10 cancelled), and the
 * pilot (S5b) has not run. Each number is an [ASSUME] that fixes an ORDERING or a
 * CEILING decision; the decision is stated next to it. A change to any constant
 * or to the formula in score.ts / fuse.ts bumps FUSION_VERSION: Layer 2 rows are
 * keyed by (fusion_version, experience_hash), so a new version writes beside the
 * old one and the serving layer reads one version only.
 */
import type { RoleNorm } from './vocab';
import { CASTING_MIN_CONFIDENCE, CASTING_MIN_TIERS } from './vocab';
import type { EvidenceSource } from './vocab';

export const FUSION_VERSION = 'fusion-v1';
/** `sync_runs.source` of an apply run. [VERIFY: no CHECK on sync_runs.source; the D3 record needs a line for it.] */
export const FUSION_SYNC_SOURCE = 'casting_fusion';

// ── Gate (accepted 2026-11-19) ──────────────────────────────────────────────

/** A claim is served only at or above this confidence ... */
export const SERVE_MIN_CONFIDENCE = CASTING_MIN_CONFIDENCE;
/** ... with at least this many distinct tiers behind it. */
export const SERVE_MIN_TIERS = CASTING_MIN_TIERS;

// ── Tiers ───────────────────────────────────────────────────────────────────

export type Tier = 'T1' | 'T2' | 'T3';
export const TIERS: readonly Tier[] = ['T1', 'T2', 'T3'];
export const TIER_OF_SOURCE: Readonly<Record<EvidenceSource, Tier>> = {
  drive_metadata: 'T1',
  drive_activity: 'T2',
  drive_content: 'T3',
};

/**
 * Highest score one tier can contribute. [ASSUME] T1 and T2 are presence signals
 * (nobody wrote that the person held a role), so they stay far below the serving
 * threshold on their own; T3 is the only tier that states a role.
 */
export const TIER_CEILING: Readonly<Record<Tier, number>> = { T1: 0.5, T2: 0.4, T3: 0.99 };

/**
 * Several distinct files in one tier agree with each other: each file beyond the
 * first adds BREADTH_STEP, at most BREADTH_MAX_EXTRA times. [ASSUME] Small on
 * purpose: files of one project are not independent witnesses (one author, one
 * template, copies), so repetition inside a tier must never outweigh a second tier.
 */
export const BREADTH_STEP = 0.05;
export const BREADTH_MAX_EXTRA = 3;

/**
 * A claim that is not backed by at least SERVE_MIN_TIERS tiers INCLUDING T3 is
 * capped here, strictly below SERVE_MIN_CONFIDENCE. [ASSUME] "One weak signal
 * stays low", and T1 / T2 corroborate T3 and never prove a claim alone (so
 * T1 + T2 without a content mention is capped too). Keep it below the threshold.
 */
export const UNCORROBORATED_CEILING = 0.6;

// ── Pitch handling ──────────────────────────────────────────────────────────

/** campaigns.status values that mean the pitch was lost: the project never became work. */
export const PITCH_LOST_STATUSES: ReadonlySet<string> = new Set(['lost']);
/**
 * Multiplier on every evidence row of a lost-pitch project. [ASSUME] Layer 1 has
 * no document-type column, so "evidence from pitch decks" is approximated by the
 * campaign's status for all its evidence: a lost pitch has no later production
 * documents. 0.7 keeps a strong, corroborated claim servable and drops weak ones.
 */
export const LOST_PITCH_FACTOR = 0.7;

// ── Budget bands (TEMPORARY) ────────────────────────────────────────────────

/**
 * TEMPORARY cut points of `campaigns.budget` (currency: whatever the column
 * holds, not converted), accepted 2026-11-19 as a placeholder until the real
 * budget distribution is measured. [DECIDE at S1/S2 close.]
 *   budget <  mediumFrom                    -> small
 *   mediumFrom   <= budget < largeFrom      -> medium
 *   largeFrom    <= budget < veryLargeFrom  -> large
 *   budget >= veryLargeFrom                 -> very_large
 * A missing or non-positive budget gives NULL (unknown).
 */
export const BUDGET_BAND_CUTS = {
  mediumFrom: 250_000,
  largeFrom: 1_000_000,
  veryLargeFrom: 2_500_000,
} as const;

// ── Conflicts ───────────────────────────────────────────────────────────────

/**
 * Roles that one project normally has ONE holder of. Two different people with
 * a servable claim to the same role on the same project, at overlapping (or
 * unknown) periods, are a conflict: both are withheld. [ASSUME] Layer 1 has no
 * "sole" marker, so this over-withholds real co-producers. Empty the set to
 * switch the rule off.
 */
export const SINGLE_HOLDER_ROLES: ReadonlySet<RoleNorm> = new Set<RoleNorm>([
  'executive_producer',
  'producer',
]);

export type RoleFamily =
  | 'creative'
  | 'strategy'
  | 'client_service'
  | 'technology_data'
  | 'media_comms'
  | 'finance'
  | 'other';

/**
 * Role families for the contradiction rule. [ASSUME] One person with servable
 * claims in two different families (not `other`) on the same project is a
 * contradiction: all those claims are withheld. Several roles inside one family
 * (a copywriter who is also an art director) are not. `designer` sits with
 * `creative`; producers sit with client service (delivery side).
 */
export const ROLE_FAMILY: Readonly<Record<RoleNorm, RoleFamily>> = {
  executive_creative_director: 'creative',
  creative_director: 'creative',
  associate_creative_director: 'creative',
  art_director: 'creative',
  copywriter: 'creative',
  designer: 'creative',
  design_director: 'creative',
  strategy_director: 'strategy',
  strategist: 'strategy',
  account_director: 'client_service',
  account_manager: 'client_service',
  account_executive: 'client_service',
  executive_producer: 'client_service',
  producer: 'client_service',
  production_manager: 'client_service',
  project_manager: 'client_service',
  technologist: 'technology_data',
  data_analyst: 'technology_data',
  media_planner: 'media_comms',
  social_media_specialist: 'media_comms',
  pr_specialist: 'media_comms',
  finance: 'finance',
  other: 'other',
};

// ── Storage ─────────────────────────────────────────────────────────────────

/**
 * Claims with NO content (T3) row behind them are presence-only (T1 / T2): every
 * (person, project) pair of a busy drive. They are recomputable from Layer 1 and
 * would dwarf the rest of Layer 2, so they are counted, not stored.
 */
export const STORE_PRESENCE_ONLY_CLAIMS = false;

/** Rows per INSERT into `experience` (19 columns each, far below the 65535-parameter limit). */
export const EXPERIENCE_INSERT_BATCH = 500;
/** Rows per INSERT into `experience_evidence_links` (3 parameters each). */
export const LINK_INSERT_BATCH = 2000;
