/**
 * Closed sets and thresholds the fusion stage reads and writes.
 *
 * All of them come from the casting module of '@anomaly-technology/gub-schemas'
 * (`src/casting.ts`, since 1.26.0), re-exported here under the same names.
 * `__tests__/vocab-drift.test.ts` compares the serving thresholds with a
 * committed snapshot, so a package bump that changes one fails loudly.
 *
 * The role, seniority, person-kind and withheld-reason sets, and the employment
 * tolerance, are re-exported through the identity module (one import path).
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

/**
 * Serving thresholds (accepted 2026-11-19): a served claim needs at least
 * CASTING_MIN_CONFIDENCE confidence and at least CASTING_MIN_TIERS distinct
 * tiers (sources) behind it.
 */
export { CASTING_MIN_CONFIDENCE, CASTING_MIN_TIERS } from '@anomaly-technology/gub-schemas';
