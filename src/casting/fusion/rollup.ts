/**
 * Rollup of the fused claims into the staff work join tables (fusion-v4,
 * gcp-universal-schemas#39, UB ARCHITECTURE-DECISIONS D43).
 *
 * The formula is the one of fusion-v3 (fuse.ts, score.ts); only the output
 * changes. One claim is (staff, project, role); the tables are:
 *
 *   staff_campaigns  one row per (staff, campaign, piece, role): the claims whose
 *                    project resolves to a campaign. A piece-level claim does
 *                    not also produce a piece-less row.
 *   staff_accounts   one row per (staff, account, role): EVERY claim on the
 *                    account, its campaigns' claims and the account-level ones
 *                    (job-only and folder-name projects, projectless claims).
 *
 * A row built from several claims:
 *   - is served (withheld_reason NULL) when at least one of them is served, and
 *     then every other column comes from the SERVED claims only;
 *   - otherwise is withheld, `conflicting` before `unconfirmed`, built from all
 *     of its claims;
 *   - period = envelope (earliest known start, latest known end; an end before
 *     the start is dropped to NULL so the period CHECK holds);
 *   - confidence = the strongest claim; tiers = the distinct tiers across the
 *     claims; seniority = the highest; activity_checked = the rolled period is
 *     dated and a T2 row stands behind it (the v3 validation rule);
 *   - evidence = the union of the claims' Layer 1 rows.
 *
 * Pure and deterministic: ids and hashes come from content, never from the clock.
 */
import { createHash } from 'node:crypto';
import { STAFF_WORK_SOURCE } from './constants';
import { highestSeniority, uuidFromText, validationLabel } from './fuse';
import { assertStaffWorkInvariants } from './invariants';
import type { FusedClaim, StaffAccountDraft, StaffCampaignDraft, StaffWorkRollup } from './types';
import type { RoleNorm, StaffWorkWithheldReason } from './vocab';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** sha256 over staff, account and role: the `staff_accounts.row_hash` definition. */
export function staffAccountHash(
  staffId: string,
  accountId: string,
  roleNorm: RoleNorm | null,
): string {
  return sha256(JSON.stringify(['staff_account', staffId, accountId, roleNorm ?? '']));
}

/** sha256 over staff, campaign, piece and role: the `staff_campaigns.row_hash` definition. */
export function staffCampaignHash(
  staffId: string,
  campaignId: string,
  pieceId: string | null,
  roleNorm: RoleNorm | null,
): string {
  return sha256(
    JSON.stringify(['staff_campaign', staffId, campaignId, pieceId ?? '', roleNorm ?? '']),
  );
}

export const staffAccountId = (buildVersion: string, hash: string): string =>
  uuidFromText(`staff_account|${buildVersion}|${hash}`);
export const staffCampaignId = (buildVersion: string, hash: string): string =>
  uuidFromText(`staff_campaign|${buildVersion}|${hash}`);
export const staffWorkLinkId = (rowId: string, evidenceId: string): string =>
  uuidFromText(`staff_work_link|${rowId}|${evidenceId}`);

/** The columns both tables share, rolled up from a group of claims. */
interface Rolled {
  roleNorm: RoleNorm | null;
  seniority: StaffAccountDraft['seniority'];
  periodStart: string | null;
  periodEnd: string | null;
  confidence: number;
  tiers: number;
  activityChecked: boolean;
  withheldReason: StaffWorkWithheldReason | null;
  evidenceIds: string[];
}

function rollGroup(group: readonly FusedClaim[]): Rolled {
  const served = group.filter((c) => c.row.withheldReason === null);
  const base = served.length > 0 ? served : group;
  let withheldReason: StaffWorkWithheldReason | null = null;
  if (served.length === 0) {
    withheldReason = group.some((c) => c.row.withheldReason === 'conflicting')
      ? 'conflicting'
      : 'unconfirmed';
  }

  const starts = base.map((c) => c.row.periodStart).filter((d): d is string => d !== null);
  const ends = base.map((c) => c.row.periodEnd).filter((d): d is string => d !== null);
  const periodStart = starts.length > 0 ? [...starts].sort(byText)[0]! : null;
  let periodEnd = ends.length > 0 ? [...ends].sort(byText)[ends.length - 1]! : null;
  if (periodStart !== null && periodEnd !== null && periodEnd < periodStart) periodEnd = null;

  const tiers = new Set(base.flatMap((c) => c.tiers));
  const evidenceIds = [...new Set(base.flatMap((c) => c.evidenceIds))].sort(byText);

  return {
    roleNorm: (base[0] as FusedClaim).row.roleNorm,
    seniority: highestSeniority(base.map((c) => c.row.seniority)),
    periodStart,
    periodEnd,
    confidence: Math.max(...base.map((c) => c.row.confidence)),
    tiers: tiers.size,
    activityChecked:
      validationLabel(periodStart, periodEnd, tiers.has('T2')) === 'activity_checked',
    withheldReason,
    evidenceIds,
  };
}

function groupBy(claims: readonly FusedClaim[], key: (c: FusedClaim) => string | null) {
  const groups = new Map<string, FusedClaim[]>();
  for (const c of claims) {
    const k = key(c);
    if (k === null) continue;
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  return [...groups.entries()].sort(([a], [b]) => byText(a, b));
}

/**
 * Rolls the stored claims of ONE account up into its staff work rows. Every
 * claim must belong to `accountId` (fusion runs one account at a time).
 */
export function rollUp(args: {
  accountId: string;
  buildVersion: string;
  claims: readonly FusedClaim[];
}): StaffWorkRollup {
  const { accountId, buildVersion } = args;
  for (const c of args.claims) {
    if (c.row.accountId !== accountId) {
      throw new Error(
        `rollup: a claim of account ${c.row.accountId} in the rollup of ${accountId}`,
      );
    }
  }

  const accounts: StaffAccountDraft[] = groupBy(args.claims, (c) =>
    JSON.stringify([c.row.staffId, c.row.roleNorm ?? '']),
  ).map(([, group]) => {
    const first = group[0] as FusedClaim;
    const rolled = rollGroup(group);
    const rowHash = staffAccountHash(first.row.staffId, accountId, rolled.roleNorm);
    return {
      id: staffAccountId(buildVersion, rowHash),
      staffId: first.row.staffId,
      accountId,
      source: STAFF_WORK_SOURCE,
      buildVersion,
      rowHash,
      ...rolled,
    };
  });

  const campaigns: StaffCampaignDraft[] = groupBy(args.claims, (c) =>
    c.row.campaignId === null
      ? null
      : JSON.stringify([
          c.row.staffId,
          c.row.campaignId,
          c.row.pieceId ?? '',
          c.row.roleNorm ?? '',
        ]),
  ).map(([, group]) => {
    const first = group[0] as FusedClaim;
    const rolled = rollGroup(group);
    const campaignId = first.row.campaignId as string;
    const pieceId = first.row.pieceId;
    // The durable project key for a re-attach after a merge (D23): the claims'
    // job number when they agree on one, the first in text order otherwise.
    const jobs = [
      ...new Set(group.map((c) => c.row.jobNumber).filter((j): j is string => j !== null)),
    ].sort(byText);
    const rowHash = staffCampaignHash(first.row.staffId, campaignId, pieceId, rolled.roleNorm);
    return {
      id: staffCampaignId(buildVersion, rowHash),
      staffId: first.row.staffId,
      campaignId,
      pieceId,
      jobNumber: jobs[0] ?? null,
      source: STAFF_WORK_SOURCE,
      buildVersion,
      rowHash,
      ...rolled,
    };
  });

  for (const r of accounts) assertStaffWorkInvariants(r);
  for (const r of campaigns) assertStaffWorkInvariants(r);
  return { accounts, campaigns };
}
