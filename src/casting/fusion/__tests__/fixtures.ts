/**
 * Synthetic data for the fusion tests. Every id, job code and name is invented;
 * no live database, Drive or model is touched. The generator is seeded, so a
 * failing property test reproduces from its seed alone.
 */
import type {
  FusionAccount,
  FusionCampaign,
  FusionEvidence,
  FusionInput,
  FusionPiece,
  FusionStaff,
} from '../types';
import { ROLE_NORMS, SENIORITIES, type EvidenceSource, type RoleNorm } from '../vocab';

/** A valid, deterministic UUID from a namespace digit and a number. */
export const uid = (ns: number, n: number): string =>
  `${String(ns).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ACCOUNT = uid(1, 1);
export const OTHER_ACCOUNT = uid(1, 2);
export const TODAY = '2026-11-19';

let counter = 0;
/** Resets the evidence id counter; call in beforeEach where ids matter. */
export const resetIds = (): void => {
  counter = 0;
};

export function ev(p: Partial<FusionEvidence> & Pick<FusionEvidence, 'source'>): FusionEvidence {
  counter += 1;
  return {
    id: uid(9, counter),
    staffId: STAFF_A,
    personKind: 'staff',
    accountId: ACCOUNT,
    jobNumber: null,
    campaignId: null,
    pieceId: null,
    roleNorm: null,
    seniority: null,
    periodStart: null,
    periodEnd: null,
    fileId: `file-${counter}`,
    location: null,
    confidence: 0.3,
    hasQuote: true,
    hasRole: true,
    withheldReason: null,
    extractorVersion:
      p.source === 'drive_content' ? 't3-v1' : p.source === 'drive_activity' ? 't2-v1' : 't1-v1',
    ...p,
  };
}

export const STAFF_A = uid(2, 1);
export const STAFF_B = uid(2, 2);
export const STAFF_C = uid(2, 3);
export const STAFF_FORMER = uid(2, 4);
export const STAFF_NEW = uid(2, 5);

export const CAMPAIGN = uid(3, 1);
export const CAMPAIGN_LOST = uid(3, 2);
export const PIECE = uid(4, 1);
export const PIECE_JOB = 'JOB0000001';

export const staff = (): FusionStaff[] => [
  { staffId: STAFF_A, startedAt: '2019-03-01', isCurrent: true },
  { staffId: STAFF_B, startedAt: '2018-01-15', isCurrent: true },
  { staffId: STAFF_C, startedAt: null, isCurrent: true },
  { staffId: STAFF_FORMER, startedAt: '2015-01-01', isCurrent: false },
  { staffId: STAFF_NEW, startedAt: '2025-06-01', isCurrent: true },
];

export const accounts = (): FusionAccount[] => [{ id: ACCOUNT }, { id: OTHER_ACCOUNT }];

export const campaigns = (): FusionCampaign[] => [
  {
    id: CAMPAIGN,
    accountId: ACCOUNT,
    status: 'awarded',
    awardedAt: '2023-02-01',
    liveAt: '2023-04-01',
    endsAt: '2023-12-31',
  },
  {
    id: CAMPAIGN_LOST,
    accountId: ACCOUNT,
    status: 'lost',
    awardedAt: null,
    liveAt: null,
    endsAt: null,
  },
];

export const pieces = (): FusionPiece[] => [
  { id: PIECE, campaignId: CAMPAIGN, jobNumber: PIECE_JOB },
];

export function baseInput(evidence: FusionEvidence[]): FusionInput {
  return {
    evidence,
    campaigns: campaigns(),
    pieces: pieces(),
    staff: staff(),
  };
}

// ── seeded generator ────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface GeneratorOptions {
  staff?: number;
  projects?: number;
}

/**
 * A random but internally consistent Layer 1 + catalog: several accounts, lost
 * pitches, name-keyed and projectless projects, every tier, external and
 * quarantined rows, re-scans under a newer extractor version, former staff.
 */
export function generateInput(seed: number, opts: GeneratorOptions = {}): FusionInput {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const chance = (p: number): boolean => rnd() < p;
  const day = (y: number, m: number, d: number): string =>
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const staffCount = opts.staff ?? 12;
  const projectCount = opts.projects ?? 24;
  const accountIds = [ACCOUNT, OTHER_ACCOUNT, uid(1, 3)];

  const staffList: FusionStaff[] = [];
  for (let i = 0; i < staffCount; i++) {
    staffList.push({
      staffId: uid(5, i + 1),
      startedAt: chance(0.2)
        ? null
        : day(2016 + Math.floor(rnd() * 8), 1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28)),
      isCurrent: chance(0.8),
    });
  }

  const campaignList: FusionCampaign[] = [];
  const pieceList: FusionPiece[] = [];
  const projectRefs: Array<
    Pick<FusionEvidence, 'accountId' | 'jobNumber' | 'campaignId' | 'pieceId' | 'location'>
  > = [];
  for (let i = 0; i < projectCount; i++) {
    const accountId = pick(accountIds);
    const kind = Math.floor(rnd() * 5);
    const year = 2021 + Math.floor(rnd() * 5);
    const campaignId = uid(6, i + 1);
    campaignList.push({
      id: campaignId,
      accountId,
      status: pick(['pitch', 'awarded', 'in_progress', 'live', 'ended', 'lost', null]),
      awardedAt: chance(0.3) ? null : day(year, 1 + Math.floor(rnd() * 6), 5),
      liveAt: chance(0.5) ? null : day(year, 7, 1),
      endsAt: chance(0.5) ? null : day(year, 12, 20),
    });
    const pieceId = uid(7, i + 1);
    const jobNumber = `GEN${String(100000 + i)}`;
    pieceList.push({ id: pieceId, campaignId, jobNumber });
    if (kind === 0) projectRefs.push({ accountId, jobNumber, campaignId, pieceId, location: null });
    else if (kind === 1)
      projectRefs.push({ accountId, jobNumber, campaignId: null, pieceId: null, location: null });
    else if (kind === 2)
      projectRefs.push({ accountId, jobNumber: null, campaignId, pieceId: null, location: null });
    else if (kind === 3)
      projectRefs.push({
        accountId,
        jobNumber: null,
        campaignId: null,
        pieceId: null,
        location: `name:project-${i}`,
      });
    else
      projectRefs.push({
        accountId,
        jobNumber: null,
        campaignId: null,
        pieceId: null,
        location: null,
      });
  }

  const sources: EvidenceSource[] = ['drive_metadata', 'drive_activity', 'drive_content'];
  const rows: FusionEvidence[] = [];
  let n = 0;
  const add = (r: Partial<FusionEvidence> & Pick<FusionEvidence, 'source' | 'accountId'>): void => {
    n += 1;
    rows.push({
      id: uid(8, n),
      staffId: null,
      personKind: 'staff',
      jobNumber: null,
      campaignId: null,
      pieceId: null,
      roleNorm: null,
      seniority: null,
      periodStart: null,
      periodEnd: null,
      fileId: `gen-file-${n}`,
      location: null,
      confidence: 0.3,
      hasQuote: true,
      hasRole: true,
      withheldReason: null,
      extractorVersion: 'v1',
      ...r,
    });
  };

  for (const ref of projectRefs) {
    const people = 1 + Math.floor(rnd() * 4);
    for (let p = 0; p < people; p++) {
      const staffId = pick(staffList).staffId;
      const files = ref.location !== null ? 1 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 4);
      for (const source of sources) {
        const count =
          source === 'drive_activity'
            ? Math.floor(rnd() * 3)
            : source === 'drive_content'
              ? Math.floor(rnd() * 3)
              : files;
        for (let k = 0; k < count; k++) {
          const isContent = source === 'drive_content';
          const role: RoleNorm | null = isContent && chance(0.85) ? pick(ROLE_NORMS) : null;
          const year = 2021 + Math.floor(rnd() * 5);
          const hasPeriod = source !== 'drive_activity' && chance(isContent ? 0.6 : 0.9);
          const base = {
            source,
            accountId: ref.accountId,
            jobNumber: ref.jobNumber,
            campaignId: ref.campaignId,
            pieceId: ref.pieceId,
            location: source === 'drive_metadata' ? ref.location : null,
            staffId,
            roleNorm: role,
            seniority: role !== null && chance(0.4) ? pick(SENIORITIES) : null,
            periodStart: hasPeriod ? day(year, 1, 1) : null,
            periodEnd: hasPeriod ? day(year, 12, 31) : null,
            confidence: isContent
              ? 0.6 + rnd() * 0.4
              : source === 'drive_activity'
                ? 0.1 + rnd() * 0.08
                : 0.15 + rnd() * 0.15,
            extractorVersion: isContent ? 't3-v1' : source === 'drive_activity' ? 't2-v1' : 't1-v1',
          };
          add(base);
          // A re-scan under a newer extractor version rewrites the same file.
          if (chance(0.1)) {
            const last = rows[rows.length - 1] as FusionEvidence;
            add({
              ...base,
              fileId: last.fileId,
              extractorVersion: base.extractorVersion.replace('v1', 'v2'),
              confidence: Math.min(1, base.confidence + 0.05),
            });
          }
        }
      }
    }
    // Rows that must never reach Layer 2.
    if (chance(0.5)) {
      add({
        source: 'drive_content',
        accountId: ref.accountId,
        jobNumber: ref.jobNumber,
        campaignId: ref.campaignId,
        pieceId: ref.pieceId,
        personKind: 'external_unresolved',
        withheldReason: 'unresolved',
        roleNorm: pick(ROLE_NORMS),
        confidence: 0,
      });
    }
    if (chance(0.3)) {
      add({
        source: 'drive_content',
        accountId: ref.accountId,
        jobNumber: ref.jobNumber,
        campaignId: ref.campaignId,
        pieceId: ref.pieceId,
        personKind: 'quarantined',
        withheldReason: 'ambiguous',
        roleNorm: pick(ROLE_NORMS),
        confidence: 0,
      });
    }
  }

  const activityStartByAccount = new Map<string, string | null>([
    [accountIds[0] as string, '2025-11-01'],
    [accountIds[1] as string, null],
  ]);
  return {
    evidence: rows,
    campaigns: campaignList,
    pieces: pieceList,
    staff: staffList,
    activityStartByAccount,
  };
}
