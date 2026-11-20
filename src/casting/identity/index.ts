export { buildRosterIndex } from './roster-index';
export type { RosterIndex } from './roster-index';
export { resolveIdentity } from './resolve';
export { normalizeRole } from './role-normalizer';
export type { RoleNormalization } from './role-normalizer';
export {
  CASTING_EMPLOYMENT_START_TOLERANCE_DAYS,
  PERSON_KINDS,
  ROLE_NORMS,
  SENIORITIES,
  WITHHELD_REASONS,
} from './vocab';
export type { PersonKind, RoleNorm, Seniority, WithheldReason } from './vocab';
export { MATCH_METHODS, MATCH_STRENGTH } from './types';
export type {
  ExternalReason,
  ExternalResolution,
  IdentityResolution,
  KnownExternal,
  MatchMethod,
  Mention,
  QuarantineReason,
  QuarantinedResolution,
  ResolutionContext,
  RosterEntry,
  RosterIndexOptions,
  StaffResolution,
} from './types';
