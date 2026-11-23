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

export const FUSION_VERSION = 'fusion-v3';
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
export const TIER_CEILING: Readonly<Record<Tier, number>> = { T1: 0.5, T2: 0.4, T3: 0.85 };

/**
 * T3 row strength (a content mention): what the mention itself shows, capped by
 * the name-match strength. A bare mention is T3_BASE; a quote grounded in the
 * text and a stated role each add a step. Before this, the name-match strength
 * alone (0.95 for an exact name) set every content row, so every served claim
 * scored 0.96 to 1.00 and confidence could not rank them.
 */
export const T3_BASE = 0.6;
export const T3_QUOTE_STEP = 0.1;
export const T3_ROLE_STEP = 0.1;

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

// ── Conflicts ───────────────────────────────────────────────────────────────

/**
 * Roles that one project has ONE holder of. Two different people with a servable
 * claim to the same role on the same project, at overlapping (or unknown)
 * periods, are a conflict: both are withheld. Layer 1 has no "sole" marker, so
 * the set is kept to the one role where a second holder is a real contradiction
 * (user ruling 2026-11-20: `producer` is NOT in it, projects have co-producers).
 * Empty the set to switch the rule off.
 */
export const SINGLE_HOLDER_ROLES: ReadonlySet<RoleNorm> = new Set<RoleNorm>(['executive_producer']);

/** An unordered pair of roles one person cannot hold on the same project. */
export type IncompatibleRolePair = readonly [RoleNorm, RoleNorm];

/**
 * Pairs of roles that contradict each other when the SAME person has a servable
 * claim to both on the SAME project: both claims are withheld as `conflicting`.
 * An explicit short list, not role families, and deliberately conservative: a small
 * agency legitimately combines neighbouring crafts (strategist and copywriter,
 * art director and designer), so only combinations from opposite ends of the
 * agency are listed. Two pairs, set by the Casting contact 2026-11-20;
 * finance + account_director and account_director + art_director were considered
 * and deliberately left out. Reasons are in docs/casting-fusion.md. Order inside a pair does not matter.
 */
export const INCOMPATIBLE_ROLE_PAIRS: readonly IncompatibleRolePair[] = [
  ['finance', 'creative_director'],
  ['executive_creative_director', 'account_executive'],
];

// ── Storage ─────────────────────────────────────────────────────────────────

/**
 * Claims with NO content (T3) row behind them are presence-only (T1 / T2): every
 * (person, project) pair of a busy drive. They are recomputable from Layer 1 and
 * would dwarf the rest of Layer 2, so they are counted, not stored.
 */
export const STORE_PRESENCE_ONLY_CLAIMS = false;

/** Rows per INSERT into `experience` (15 columns each, far below the 65535-parameter limit). */
export const EXPERIENCE_INSERT_BATCH = 500;
/** Rows per INSERT into `experience_evidence_links` (3 parameters each). */
export const LINK_INSERT_BATCH = 2000;
