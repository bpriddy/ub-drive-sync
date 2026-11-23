/**
 * The row-level constraints of the `experience` table, mirrored (gub-schemas
 * `experienceRowSchema` and the `DB CHECK experience_*` lines, unpublished
 * 1.23.0). A violation is a bug in this stage, never data, so it throws.
 */
import type { ExperienceDraft } from './types';
import { ROLE_NORMS, SENIORITIES, WITHHELD_REASONS } from './vocab';

const inSet = (set: readonly string[], v: string | null): boolean => v === null || set.includes(v);

export function assertExperienceInvariants(r: ExperienceDraft): void {
  const fail = (m: string): never => {
    throw new Error(`experience invariant: ${m}`);
  };
  if (r.staffId.length === 0 || r.accountId.length === 0)
    fail('staff_id and account_id are required');
  if (!inSet(ROLE_NORMS, r.roleNorm)) fail('role_norm');
  if (!inSet(SENIORITIES, r.seniority)) fail('seniority');
  if (!inSet(WITHHELD_REASONS, r.withheldReason)) fail('withheld_reason');
  if (!(r.confidence >= 0 && r.confidence <= 1)) fail('confidence range');
  if (r.periodStart !== null && r.periodEnd !== null && r.periodEnd < r.periodStart)
    fail('period order');
  if (r.fusionVersion.length === 0 || r.experienceHash.length === 0) fail('empty required text');
}
