/**
 * Layer 1 -> Layer 2: the deterministic fusion function.
 *
 * `fuse` is a pure function of its input (Layer 1 rows, campaigns,
 * pieces, staff). It reads no clock, no database, no environment and calls no
 * model. The same input in any row order gives identical claims, hashes, ids and
 * metrics. The formula is documented in score.ts and docs/casting-fusion.md.
 *
 * Steps:
 *   1. drop duplicate ids, sort by id (so nothing below depends on input order);
 *   2. supersede older extractor versions per (source, file), then keep only the newest
 *      load of each T3 file (an older content version is not counted);
 *   3. map every row to a canonical project (project.ts);
 *   4. keep only resolved, non-withheld STAFF rows of CURRENT staff. External,
 *      quarantined and former-staff rows stay in Layer 1 and never reach Layer 2;
 *   5. one claim per (person, project, role). T1 / T2 rows state no role: they are
 *      presence evidence and corroborate every role claim of that person on that
 *      project. A person with no stated role on a project gets one role-less claim;
 *   6. score (score.ts), derive the period (period.ts), apply the roster window
 *      (30 days before startedAt, NO end gate);
 *   7. withhold: `conflicting` (window violation, two people as sole holder of a
 *      role, one person in contradictory role families) or `unconfirmed` (below
 *      the gate, or no project). Both are stored and never served; there is no
 *      review queue;
 *   8. the same person with several seniority values on one project and role:
 *      the HIGHEST wins.
 */
import { createHash } from 'node:crypto';
import {
  FUSION_VERSION,
  LOST_PITCH_FACTOR,
  PITCH_LOST_STATUSES,
  INCOMPATIBLE_ROLE_PAIRS,
  SERVE_MIN_CONFIDENCE,
  SERVE_MIN_TIERS,
  SINGLE_HOLDER_ROLES,
  STORE_PRESENCE_ONLY_CLAIMS,
  TIER_OF_SOURCE,
} from './constants';
import { assertExperienceInvariants } from './invariants';
import { addDays, deriveClaimPeriod, envelope, campaignPeriod, periodsOverlap } from './period';
import { keepNewestLoadPerFile } from './newest-load';
import { createProjectResolver, type ProjectRef } from './project';
import { scoreClaim, type ScoreRow } from './score';
import { supersedeByVersion } from './supersede';
import type {
  FusedClaim,
  FusionEvidence,
  FusionInput,
  FusionMetrics,
  FusionOutput,
  FusionStaff,
  TierMetrics,
  ValidationLabel,
} from './types';
import {
  CASTING_EMPLOYMENT_START_TOLERANCE_DAYS,
  SENIORITIES,
  type RoleNorm,
  type Seniority,
  type WithheldReason,
} from './vocab';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A deterministic UUID (v5-shaped) from text: stable ids across rebuilds. */
export function uuidFromText(text: string): string {
  const b = createHash('sha256').update(text).digest().subarray(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x50;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Hash over staff, project, role and period start (the schema's definition). */
export function experienceHash(parts: {
  staffId: string;
  projectKey: string;
  roleNorm: RoleNorm | null;
  periodStart: string | null;
}): string {
  return sha256(
    JSON.stringify([
      'experience',
      parts.staffId,
      parts.projectKey,
      parts.roleNorm ?? '',
      parts.periodStart ?? '',
    ]),
  );
}

/**
 * The validation label, one definition for this stage and for the serving layer
 * (S7). `activity_checked` = the claim is DATED (a period start or end is known)
 * AND some Layer 1 row behind it has source `drive_activity` (T2). Anything else,
 * including every undated claim and every claim with no T2 row, is `not_validated`.
 * It is a label about checkability, never an accuracy figure; it is not stored.
 */
export function validationLabel(
  periodStart: string | null,
  periodEnd: string | null,
  hasActivityEvidence: boolean,
): ValidationLabel {
  const dated = periodStart !== null || periodEnd !== null;
  return dated && hasActivityEvidence ? 'activity_checked' : 'not_validated';
}

export const experienceId = (fusionVersion: string, hash: string): string =>
  uuidFromText(`experience|${fusionVersion}|${hash}`);
export const linkId = (experienceId_: string, evidenceId: string): string =>
  uuidFromText(`link|${experienceId_}|${evidenceId}`);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedRecord = <T>(rec: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).sort(([a], [b]) => byText(a, b)));
const share = (n: number, d: number): number | null =>
  d === 0 ? null : Math.round((n / d) * 1000) / 1000;
const yearKey = (day: string | null): string => (day === null ? 'unknown' : day.slice(0, 4));

const newTierMetrics = (): TierMetrics => ({
  rows: 0,
  staff: 0,
  externalUnresolved: 0,
  quarantined: 0,
  claims: 0,
  servedClaims: 0,
});

/** Highest seniority of the given values (SENIORITIES is ordered low to high); null when none. */
export function highestSeniority(values: readonly (Seniority | null)[]): Seniority | null {
  let best = -1;
  for (const v of values) {
    if (v === null) continue;
    const i = SENIORITIES.indexOf(v);
    if (i > best) best = i;
  }
  return best < 0 ? null : (SENIORITIES[best] as Seniority);
}

interface Pending {
  staffId: string;
  accountId: string;
  ref: ProjectRef;
  projectKey: string;
  projectless: boolean;
  roleNorm: RoleNorm | null;
  rows: FusionEvidence[];
  roleRows: FusionEvidence[];
  pitchFactor: number;
  score: ReturnType<typeof scoreClaim>;
  period: ReturnType<typeof deriveClaimPeriod>;
  startedAt: string | null;
  windowViolation: boolean;
  gate: boolean;
  reason: WithheldReason | null;
}

export function fuse(input: FusionInput): FusionOutput {
  const metrics: FusionMetrics = {
    evidenceRows: input.evidence.length,
    duplicateIds: 0,
    superseded: 0,
    olderContentVersion: 0,
    staffRowsDropped: { notCurrent: 0, unknownStaff: 0, withheldStaffRow: 0 },
    byTier: { T1: newTierMetrics(), T2: newTierMetrics(), T3: newTierMetrics() },
    claims: {
      formed: 0,
      stored: 0,
      presenceOnlyNotStored: 0,
      served: 0,
      withheld: { conflicting: 0, unconfirmed: 0 },
      projectless: 0,
      servedWithMinTiers: 0,
    },
    crossDocumentAgreement: { claims: 0, withTwoFiles: 0, share: null },
    t2Agreement: { claims: 0, withT2: 0, share: null },
    coverage: {},
    servedByYear: {},
  };

  // 1. duplicate ids (a re-delivered row), then a total order by id.
  const unique = new Map<string, FusionEvidence>();
  for (const r of input.evidence) {
    const seen = unique.get(r.id);
    if (seen === undefined) unique.set(r.id, r);
    else {
      metrics.duplicateIds += 1;
      if (JSON.stringify(r) < JSON.stringify(seen)) unique.set(r.id, r);
    }
  }
  const sorted = [...unique.values()].sort((a, b) => byText(a.id, b.id));

  // 2. supersede by extractor_version.
  const { kept: current, superseded } = supersedeByVersion(sorted);
  metrics.superseded = superseded;
  // 2b. a T3 file read again after an edit: only the newest load counts.
  const { kept: rows, droppedOlderLoad } = keepNewestLoadPerFile(current);
  metrics.olderContentVersion = droppedOlderLoad;

  const staffById = new Map<string, FusionStaff>(input.staff.map((s) => [s.staffId, s]));
  const resolve = createProjectResolver(input.campaigns, input.pieces);

  // 3. project per row; project-level facts (T1 period rows, coverage flags).
  interface ProjectInfo {
    accountId: string;
    ref: ProjectRef;
    t1Rows: FusionEvidence[];
    hasResolvedPerson: boolean;
    hasServed: boolean;
  }
  const projects = new Map<string, ProjectInfo>();
  const refs: ProjectRef[] = [];
  for (const r of rows) {
    const ref = resolve(r);
    refs.push(ref);
    const tier = TIER_OF_SOURCE[r.source];
    const tm = metrics.byTier[tier];
    tm.rows += 1;
    if (r.personKind === 'staff') tm.staff += 1;
    else if (r.personKind === 'external_unresolved') tm.externalUnresolved += 1;
    else tm.quarantined += 1;
    if (ref.key === null) continue;
    let p = projects.get(ref.key);
    if (p === undefined) {
      p = { accountId: r.accountId, ref, t1Rows: [], hasResolvedPerson: false, hasServed: false };
      projects.set(ref.key, p);
    }
    if (tier === 'T1') p.t1Rows.push(r);
    if (r.personKind === 'staff') p.hasResolvedPerson = true;
  }

  // 4. the staff rows that may become claims, grouped by (person, project).
  const groups = new Map<
    string,
    { staffId: string; ref: ProjectRef; key: string; rows: FusionEvidence[] }
  >();
  rows.forEach((r, i) => {
    if (r.personKind !== 'staff' || r.staffId === null) return;
    if (r.withheldReason !== null) {
      metrics.staffRowsDropped.withheldStaffRow += 1;
      return;
    }
    const staff = staffById.get(r.staffId);
    if (staff === undefined) {
      metrics.staffRowsDropped.unknownStaff += 1;
      return;
    }
    if (!staff.isCurrent) {
      metrics.staffRowsDropped.notCurrent += 1;
      return;
    }
    const ref = refs[i] as ProjectRef;
    const key = ref.key ?? `none:${r.accountId}`;
    const gk = `${r.staffId}\u0000${key}`;
    let g = groups.get(gk);
    if (g === undefined) {
      g = { staffId: r.staffId, ref, key, rows: [] };
      groups.set(gk, g);
    }
    g.rows.push(r);
  });

  // 5-6. claims.
  const pending: Pending[] = [];
  for (const gk of [...groups.keys()].sort(byText)) {
    const g = groups.get(gk)!;
    const staff = staffById.get(g.staffId) as FusionStaff;
    const accountId = (g.rows[0] as FusionEvidence).accountId;
    const projectless = g.ref.key === null;
    const roleRows = new Map<RoleNorm, FusionEvidence[]>();
    const presence: FusionEvidence[] = [];
    for (const r of g.rows) {
      if (r.roleNorm === null) presence.push(r);
      else {
        const list = roleRows.get(r.roleNorm) ?? [];
        list.push(r);
        roleRows.set(r.roleNorm, list);
      }
    }
    const specs: { role: RoleNorm | null; rows: FusionEvidence[]; own: FusionEvidence[] }[] = [];
    if (roleRows.size > 0) {
      for (const role of [...roleRows.keys()].sort(byText)) {
        const own = roleRows.get(role) as FusionEvidence[];
        specs.push({ role, rows: [...own, ...presence], own });
      }
    } else if (presence.length > 0) {
      specs.push({ role: null, rows: presence, own: [] });
    }

    const project = g.ref.key === null ? undefined : projects.get(g.ref.key);
    for (const spec of specs) {
      metrics.claims.formed += 1;
      const hasContent = spec.rows.some((r) => TIER_OF_SOURCE[r.source] === 'T3');
      if (!hasContent && !STORE_PRESENCE_ONLY_CLAIMS) {
        metrics.claims.presenceOnlyNotStored += 1;
        continue;
      }
      const status = g.ref.campaign?.status ?? null;
      const pitchFactor =
        status !== null && PITCH_LOST_STATUSES.has(status) ? LOST_PITCH_FACTOR : 1;
      const scoreRows: ScoreRow[] = spec.rows.map((r) => ({
        tier: TIER_OF_SOURCE[r.source],
        confidence: r.confidence,
        fileId: r.fileId,
        hasQuote: r.hasQuote,
        hasRole: r.hasRole,
      }));
      const score = scoreClaim(scoreRows, pitchFactor);
      const period = deriveClaimPeriod({
        contentRows: spec.rows.filter((r) => TIER_OF_SOURCE[r.source] === 'T3'),
        projectT1Rows: project?.t1Rows ?? [],
        campaign: g.ref.campaign,
      });
      const evidenceDay = period.end ?? period.start;
      const windowViolation =
        staff.startedAt !== null &&
        evidenceDay !== null &&
        evidenceDay < addDays(staff.startedAt, -CASTING_EMPLOYMENT_START_TOLERANCE_DAYS);
      const gate =
        !projectless &&
        !score.capped &&
        score.confidence >= SERVE_MIN_CONFIDENCE &&
        score.tiers.length >= SERVE_MIN_TIERS;
      pending.push({
        staffId: g.staffId,
        accountId,
        ref: g.ref,
        projectKey: g.key,
        projectless,
        roleNorm: spec.role,
        rows: spec.rows,
        roleRows: spec.own,
        pitchFactor,
        score,
        period,
        startedAt: staff.startedAt,
        windowViolation,
        gate,
        reason: windowViolation ? 'conflicting' : gate ? null : 'unconfirmed',
      });
    }
  }

  // 7. conflicts among claims that would otherwise be served.
  const contenders = pending.filter((p) => p.reason === null);
  const conflicted = new Set<Pending>();
  const holderGroups = new Map<string, Pending[]>();
  const personGroups = new Map<string, Pending[]>();
  for (const p of contenders) {
    if (p.roleNorm !== null && SINGLE_HOLDER_ROLES.has(p.roleNorm)) {
      const k = `${p.projectKey}\u0000${p.roleNorm}`;
      holderGroups.set(k, [...(holderGroups.get(k) ?? []), p]);
    }
    const pk = `${p.staffId}\u0000${p.projectKey}`;
    personGroups.set(pk, [...(personGroups.get(pk) ?? []), p]);
  }
  for (const list of holderGroups.values()) {
    for (const a of list) {
      for (const b of list) {
        if (a !== b && a.staffId !== b.staffId && periodsOverlap(a.period, b.period)) {
          conflicted.add(a);
          conflicted.add(b);
        }
      }
    }
  }
  for (const list of personGroups.values()) {
    for (const [x, y] of INCOMPATIBLE_ROLE_PAIRS) {
      const withX = list.filter((p) => p.roleNorm === x);
      const withY = list.filter((p) => p.roleNorm === y);
      if (withX.length === 0 || withY.length === 0) continue;
      for (const p of [...withX, ...withY]) conflicted.add(p);
    }
  }
  for (const p of conflicted) p.reason = 'conflicting';

  // 8. rows.
  const claims: FusedClaim[] = pending.map((p) => {
    const hash = experienceHash({
      staffId: p.staffId,
      projectKey: p.projectKey,
      roleNorm: p.roleNorm,
      periodStart: p.period.start,
    });
    const id = experienceId(FUSION_VERSION, hash);
    const validation = validationLabel(p.period.start, p.period.end, p.score.tiers.includes('T2'));
    return {
      row: {
        id,
        staffId: p.staffId,
        accountId: p.accountId,
        jobNumber: p.ref.jobNumber,
        campaignId: p.ref.campaignId,
        pieceId: p.ref.pieceId,
        roleNorm: p.roleNorm,
        seniority: highestSeniority(p.roleRows.map((r) => r.seniority)),
        periodStart: p.period.start,
        periodEnd: p.period.end,
        confidence: p.score.confidence,
        withheldReason: p.reason,
        fusionVersion: FUSION_VERSION,
        experienceHash: hash,
      },
      projectKey: p.projectKey,
      tiers: p.score.tiers,
      tierScores: p.score.tierScores,
      pitchFactor: p.pitchFactor,
      evidenceIds: p.rows.map((r) => r.id).sort(byText),
      validation,
    };
  });
  for (const c of claims) assertExperienceInvariants(c.row);
  claims.sort((a, b) => byText(a.row.experienceHash, b.row.experienceHash));

  // 9. metrics.
  const m = metrics.claims;
  m.stored = claims.length;
  for (const c of claims) {
    const served = c.row.withheldReason === null;
    if (c.row.withheldReason === 'conflicting') m.withheld.conflicting += 1;
    if (c.row.withheldReason === 'unconfirmed') m.withheld.unconfirmed += 1;
    if (c.projectKey.startsWith('none:')) m.projectless += 1;
    for (const t of c.tiers) {
      metrics.byTier[t].claims += 1;
      if (served) metrics.byTier[t].servedClaims += 1;
    }
    if (served) {
      m.served += 1;
      if (c.tiers.length >= SERVE_MIN_TIERS) m.servedWithMinTiers += 1;
      const y = yearKey(c.row.periodStart);
      const slot = (metrics.servedByYear[y] ??= { activity_checked: 0, not_validated: 0 });
      slot[c.validation] += 1;
      const proj = projects.get(c.projectKey);
      if (proj !== undefined) proj.hasServed = true;
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of claims) {
    const contentFiles = new Set<string>();
    for (const id of c.evidenceIds) {
      const r = byId.get(id) as FusionEvidence;
      if (TIER_OF_SOURCE[r.source] === 'T3') contentFiles.add(r.fileId);
    }
    if (contentFiles.size === 0) continue;
    if (c.row.roleNorm !== null) {
      metrics.crossDocumentAgreement.claims += 1;
      if (contentFiles.size >= 2) metrics.crossDocumentAgreement.withTwoFiles += 1;
    }
    const horizon = input.activityStartByAccount?.get(c.row.accountId) ?? null;
    const day = c.row.periodEnd ?? c.row.periodStart;
    if (horizon !== null && day !== null && day >= horizon) {
      metrics.t2Agreement.claims += 1;
      if (c.tiers.includes('T2')) metrics.t2Agreement.withT2 += 1;
    }
  }
  metrics.crossDocumentAgreement.share = share(
    metrics.crossDocumentAgreement.withTwoFiles,
    metrics.crossDocumentAgreement.claims,
  );
  metrics.t2Agreement.share = share(metrics.t2Agreement.withT2, metrics.t2Agreement.claims);

  for (const p of projects.values()) {
    const proj = envelope(p.t1Rows) ?? campaignPeriod(p.ref.campaign);
    const bucket = `${p.accountId}|${yearKey(proj?.start ?? null)}`;
    const slot = (metrics.coverage[bucket] ??= {
      projects: 0,
      withResolvedPerson: 0,
      withServedClaim: 0,
    });
    slot.projects += 1;
    if (p.hasResolvedPerson) slot.withResolvedPerson += 1;
    if (p.hasServed) slot.withServedClaim += 1;
  }
  metrics.coverage = sortedRecord(metrics.coverage);
  metrics.servedByYear = sortedRecord(metrics.servedByYear);

  return { claims, metrics };
}
