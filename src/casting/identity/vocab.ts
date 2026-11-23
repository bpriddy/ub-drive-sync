/**
 * Closed sets the identity module reads and writes.
 *
 * The sets come from the casting module of '@anomaly-technology/gub-schemas'
 * (`src/casting.ts`, since 1.26.0) and are re-exported here under the same
 * names, so call sites import them from this module or from '../identity'.
 * They are the single source for the DB CHECK constraints of the evidence and
 * experience tables.
 *
 * `__tests__/vocab-drift.test.ts` compares the package sets with a committed
 * snapshot, so a package bump that changes a set fails loudly.
 */
export {
  CASTING_EMPLOYMENT_START_TOLERANCE_DAYS,
  PERSON_KINDS,
  ROLE_NORMS,
  SENIORITIES,
  WITHHELD_REASONS,
} from '@anomaly-technology/gub-schemas';
export type {
  PersonKind,
  RoleNorm,
  Seniority,
  WithheldReason,
} from '@anomaly-technology/gub-schemas';
