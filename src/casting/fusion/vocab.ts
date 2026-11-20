/**
 * Closed sets and thresholds the fusion stage reads and writes.
 *
 * MIRROR, not a source of truth, for the sets that the identity module does not
 * already carry: they copy gub-schemas `src/casting.ts` (unpublished 1.23.0,
 * read at the local epic's source tree). After 1.23.0 is pinned in package.json,
 * delete the literals below and re-export the package symbols with the same names.
 * `__tests__/vocab-drift.test.ts` compares these literals with a committed snapshot.
 *
 * The role, seniority, person-kind and withheld-reason sets, and the employment
 * tolerance, are the identity module's mirror (re-exported here, one source).
 */
export {
  CASTING_EMPLOYMENT_START_TOLERANCE_DAYS,
  PERSON_KINDS,
  ROLE_NORMS,
  SENIORITIES,
  WITHHELD_REASONS,
} from '../identity';
export type { PersonKind, RoleNorm, Seniority, WithheldReason } from '../identity';
export { EVIDENCE_SOURCES } from '../t1/types';
export type { EvidenceSource } from '../t1/types';

/** Controlled deliverable / project-type vocabulary (approved 2026-11-19). */
export const PROJECT_TYPES = [
  'tv_commercial',
  'digital_video',
  'social',
  'website',
  'app_or_interactive',
  'print',
  'out_of_home',
  'audio',
  'experiential_event',
  'brand_identity',
  'packaging',
  'integrated_campaign',
  'strategy_research',
  'other',
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** Banded campaigns.budget. The labels are frozen; the cut-offs live in constants.ts. */
export const BUDGET_BANDS = ['small', 'medium', 'large', 'very_large'] as const;
export type BudgetBand = (typeof BUDGET_BANDS)[number];

/** A served claim needs at least this confidence (accepted 2026-11-19). */
export const CASTING_MIN_CONFIDENCE = 0.7;
/** ... and at least this many distinct tiers (sources) behind it (accepted 2026-11-19). */
export const CASTING_MIN_TIERS = 2;
