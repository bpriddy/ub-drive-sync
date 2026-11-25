/**
 * The row-level constraints of a claim, as the `experience` table had them
 * (gub-schemas `experienceRowSchema`). Claims are no longer stored, but the
 * same rules keep the formula honest before the rollup. A violation is a bug in
 * this stage, never data, so it throws.
 */
import type { ExperienceDraft, StaffAccountDraft, StaffCampaignDraft } from './types';
import {
  ROLE_NORMS,
  SENIORITIES,
  STAFF_WORK_MAX_TIERS,
  STAFF_WORK_MIN_TIERS,
  STAFF_WORK_WITHHELD_REASONS,
  WITHHELD_REASONS,
} from './vocab';

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

/**
 * The row-level constraints of `staff_accounts` / `staff_campaigns` for a
 * drive_casting row, mirrored (gub-schemas 1.29.0 `staffAccountRowSchema`,
 * `staffCampaignRowSchema` and the `DB CHECK staff_*` lines, including the
 * source-shape CHECK). A violation is a bug in this stage, never data, so it throws.
 */
export function assertStaffWorkInvariants(r: StaffAccountDraft | StaffCampaignDraft): void {
  const fail = (m: string): never => {
    throw new Error(`staff work invariant: ${m}`);
  };
  const work = 'accountId' in r ? r.accountId : r.campaignId;
  if (r.staffId.length === 0 || work.length === 0) fail('staff_id and the work id are required');
  if (r.source !== 'drive_casting') fail('this stage writes drive_casting rows only');
  if (!inSet(ROLE_NORMS, r.roleNorm)) fail('role_norm');
  if (!inSet(SENIORITIES, r.seniority)) fail('seniority');
  if (!inSet(STAFF_WORK_WITHHELD_REASONS, r.withheldReason)) fail('withheld_reason');
  if (!(r.confidence >= 0 && r.confidence <= 1)) fail('confidence range');
  if (!(
    Number.isInteger(r.tiers) &&
    r.tiers >= STAFF_WORK_MIN_TIERS &&
    r.tiers <= STAFF_WORK_MAX_TIERS
  ))
    fail('tiers range');
  if (r.periodStart !== null && r.periodEnd !== null && r.periodEnd < r.periodStart)
    fail('period order');
  if (r.buildVersion.length === 0 || r.rowHash.length === 0) fail('empty required text');
  if (r.evidenceIds.length === 0) fail('a drive_casting row needs evidence behind it');
}
