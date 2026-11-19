/**
 * Closed sets the identity module reads and writes.
 *
 * MIRROR, not a source of truth. These literals copy the casting vocabularies
 * of gub-schemas (`src/casting.ts`, unpublished 1.23.0, set contents frozen at
 * source commit f8cf59f). They are declared here only because 1.23.0 is not
 * published yet and this repo cannot import it.
 *
 * Once 1.23.0 is pinned in package.json, delete the literals below and
 * re-export the package symbols instead (same names), for example:
 *
 *   export { ROLE_NORMS, SENIORITIES, PERSON_KINDS, WITHHELD_REASONS,
 *            CASTING_EMPLOYMENT_START_TOLERANCE_DAYS } from '@anomaly-technology/gub-schemas';
 *   export type { RoleNorm, Seniority, PersonKind, WithheldReason } from '...';
 *
 * `__tests__/vocab-drift.test.ts` compares these literals with a committed
 * snapshot and fails when one changes without the other. After the switch it
 * should compare the package exports with the snapshot instead.
 */

/** Controlled role vocabulary. `other` stays last: a role was stated but maps to nothing. */
export const ROLE_NORMS = [
  'executive_creative_director',
  'creative_director',
  'associate_creative_director',
  'art_director',
  'copywriter',
  'designer',
  'design_director',
  'strategy_director',
  'strategist',
  'account_director',
  'account_manager',
  'account_executive',
  'executive_producer',
  'producer',
  'production_manager',
  'project_manager',
  'technologist',
  'data_analyst',
  'media_planner',
  'social_media_specialist',
  'pr_specialist',
  'finance',
  'other',
] as const;
export type RoleNorm = (typeof ROLE_NORMS)[number];

/** Seniority marker read from the title, lowest to highest. NULL = no marker. */
export const SENIORITIES = ['junior', 'senior', 'lead', 'director', 'executive'] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const PERSON_KINDS = ['staff', 'external_unresolved', 'quarantined'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export const WITHHELD_REASONS = ['ambiguous', 'conflicting', 'unconfirmed', 'unresolved'] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

/**
 * A match is plausible only from this many days BEFORE staff.startedAt (accepted
 * by the Casting contact). There is no end-side gate: endedAt is empty for former staff.
 */
export const CASTING_EMPLOYMENT_START_TOLERANCE_DAYS = 30;
