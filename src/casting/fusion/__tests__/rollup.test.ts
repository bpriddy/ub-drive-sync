import { describe, expect, it } from 'vitest';
import {
  rollUp,
  staffAccountHash,
  staffAccountId,
  staffCampaignHash,
  staffCampaignId,
} from '../rollup';
import { fuse } from '../fuse';
import type { FusedClaim } from '../types';
import type { Tier } from '../constants';
import { ACCOUNT, OTHER_ACCOUNT, baseInput, ev, generateInput, resetIds, uid } from './fixtures';

const STAFF = uid(1, 1);
const STAFF_2 = uid(1, 2);
const CAMP = uid(3, 1);
const CAMP_2 = uid(3, 2);
const PIECE = uid(4, 1);
const BUILD = 'fusion-v9';

let n = 0;
/** A stored claim as fuse() returns it; only what the rollup reads matters. */
function claim(over: {
  staffId?: string;
  accountId?: string;
  campaignId?: string | null;
  pieceId?: string | null;
  jobNumber?: string | null;
  roleNorm?: FusedClaim['row']['roleNorm'];
  seniority?: FusedClaim['row']['seniority'];
  periodStart?: string | null;
  periodEnd?: string | null;
  confidence?: number;
  withheldReason?: FusedClaim['row']['withheldReason'];
  tiers?: Tier[];
  evidenceIds?: string[];
}): FusedClaim {
  n += 1;
  return {
    row: {
      id: uid(20, n),
      staffId: over.staffId ?? STAFF,
      accountId: over.accountId ?? ACCOUNT,
      jobNumber: over.jobNumber ?? null,
      campaignId: over.campaignId === undefined ? CAMP : over.campaignId,
      pieceId: over.pieceId ?? null,
      roleNorm: over.roleNorm === undefined ? 'copywriter' : over.roleNorm,
      seniority: over.seniority ?? null,
      periodStart: over.periodStart === undefined ? '2024-01-01' : over.periodStart,
      periodEnd: over.periodEnd === undefined ? '2024-06-30' : over.periodEnd,
      confidence: over.confidence ?? 0.8,
      withheldReason: over.withheldReason ?? null,
      fusionVersion: BUILD,
      experienceHash: `h${n}`,
    },
    projectKey: `campaign:${over.campaignId ?? CAMP}`,
    tiers: over.tiers ?? ['T1', 'T3'],
    tierScores: {},
    pitchFactor: 1,
    evidenceIds: over.evidenceIds ?? [uid(9, n)],
    validation: 'not_validated',
  };
}
const roll = (claims: FusedClaim[]) => rollUp({ accountId: ACCOUNT, buildVersion: BUILD, claims });

describe('rollUp: which rows exist', () => {
  it('a campaign claim gives one staff_campaigns row and one staff_accounts row', () => {
    const r = roll([claim({})]);
    expect(r.accounts).toHaveLength(1);
    expect(r.campaigns).toHaveLength(1);
    expect(r.accounts[0]).toMatchObject({
      staffId: STAFF,
      accountId: ACCOUNT,
      roleNorm: 'copywriter',
    });
    expect(r.campaigns[0]).toMatchObject({ staffId: STAFF, campaignId: CAMP, pieceId: null });
  });

  it('account-level claims (job-only, folder name, projectless) reach staff_accounts only', () => {
    const r = roll([
      claim({ campaignId: null, jobNumber: 'J1' }),
      claim({ campaignId: null, roleNorm: 'producer', withheldReason: 'unconfirmed' }),
    ]);
    expect(r.campaigns).toEqual([]);
    expect(r.accounts.map((a) => a.roleNorm).sort()).toEqual(['copywriter', 'producer']);
  });

  it('the account row rolls up every claim on the account: its campaigns too, one row per person and role', () => {
    const r = roll([
      claim({ campaignId: CAMP }),
      claim({ campaignId: CAMP_2 }),
      claim({ campaignId: null }),
      claim({ campaignId: CAMP, roleNorm: 'producer' }),
      claim({ campaignId: CAMP, staffId: STAFF_2 }),
    ]);
    expect(r.accounts).toHaveLength(3); // (STAFF, copywriter), (STAFF, producer), (STAFF_2, copywriter)
    expect(r.campaigns).toHaveLength(4);
  });

  it('a piece claim is its own campaign row and does not also produce a piece-less one', () => {
    const r = roll([claim({ pieceId: PIECE })]);
    expect(r.campaigns).toHaveLength(1);
    expect(r.campaigns[0]!.pieceId).toBe(PIECE);
    const both = roll([claim({ pieceId: PIECE }), claim({ pieceId: null })]);
    expect(both.campaigns.map((c) => c.pieceId).sort()).toEqual([null, PIECE].sort());
  });

  it('claims of different projects on one campaign (job key, campaign key) merge into one row', () => {
    const r = roll([claim({ jobNumber: 'J2' }), claim({ jobNumber: 'J1' }), claim({})]);
    expect(r.campaigns).toHaveLength(1);
    expect(r.campaigns[0]!.jobNumber).toBe('J1'); // the first in text order
    expect(roll([claim({})]).campaigns[0]!.jobNumber).toBeNull();
  });

  it('a role-less claim is its own row (role NULL), apart from the stated roles', () => {
    const r = roll([claim({ roleNorm: null }), claim({})]);
    expect(r.accounts.map((a) => a.roleNorm)).toEqual(expect.arrayContaining([null, 'copywriter']));
    expect(r.accounts).toHaveLength(2);
  });

  it('a claim of another account is a bug, not data', () => {
    expect(() => roll([claim({ accountId: OTHER_ACCOUNT })])).toThrow(/rollup/);
  });
});

describe('rollUp: what a row says', () => {
  it('served when one claim is served; every column then comes from the served claims only', () => {
    const r = roll([
      claim({
        confidence: 0.75,
        periodStart: '2024-03-01',
        periodEnd: '2024-04-30',
        tiers: ['T1', 'T3'],
        seniority: 'junior',
        evidenceIds: [uid(9, 101)],
      }),
      claim({
        confidence: 0.95,
        periodStart: '2019-01-01',
        periodEnd: '2025-12-31',
        tiers: ['T1', 'T2', 'T3'],
        seniority: 'executive',
        evidenceIds: [uid(9, 102)],
        withheldReason: 'conflicting',
      }),
    ]);
    expect(r.accounts[0]).toMatchObject({
      withheldReason: null,
      confidence: 0.75,
      periodStart: '2024-03-01',
      periodEnd: '2024-04-30',
      tiers: 2,
      seniority: 'junior',
      evidenceIds: [uid(9, 101)],
    });
  });

  it('withheld when no claim is served: conflicting before unconfirmed, built from all claims', () => {
    const r = roll([
      claim({ withheldReason: 'unconfirmed', confidence: 0.5 }),
      claim({ withheldReason: 'conflicting', confidence: 0.9 }),
    ]);
    expect(r.accounts[0]).toMatchObject({ withheldReason: 'conflicting', confidence: 0.9 });
    expect(r.accounts[0]!.evidenceIds).toHaveLength(2);
    expect(roll([claim({ withheldReason: 'unconfirmed' })]).accounts[0]!.withheldReason).toBe(
      'unconfirmed',
    );
  });

  it('period is the envelope of the known dates; an end before the start is dropped', () => {
    const env = roll([
      claim({ periodStart: '2024-05-01', periodEnd: '2024-07-31' }),
      claim({ periodStart: '2023-02-01', periodEnd: null }),
      claim({ periodStart: null, periodEnd: '2024-09-30' }),
    ]).accounts[0]!;
    expect([env.periodStart, env.periodEnd]).toEqual(['2023-02-01', '2024-09-30']);
    const undated = roll([claim({ periodStart: null, periodEnd: null })]).accounts[0]!;
    expect([undated.periodStart, undated.periodEnd]).toEqual([null, null]);
    const crossed = roll([
      claim({ periodStart: '2025-01-01', periodEnd: null }),
      claim({ periodStart: null, periodEnd: '2020-01-01' }),
    ]).accounts[0]!;
    expect([crossed.periodStart, crossed.periodEnd]).toEqual(['2025-01-01', null]);
  });

  it('tiers = distinct tiers across the claims; activity_checked needs a date and a T2 row', () => {
    const a = roll([claim({ tiers: ['T1', 'T3'] }), claim({ tiers: ['T2', 'T3'] })]).accounts[0]!;
    expect(a.tiers).toBe(3);
    expect(a.activityChecked).toBe(true);
    expect(roll([claim({ tiers: ['T1', 'T3'] })]).accounts[0]!.activityChecked).toBe(false);
    expect(
      roll([claim({ tiers: ['T2', 'T3'], periodStart: null, periodEnd: null })]).accounts[0]!
        .activityChecked,
    ).toBe(false);
  });

  it("evidence = the union of the claims' rows, sorted, no duplicates", () => {
    const r = roll([
      claim({ evidenceIds: [uid(9, 3), uid(9, 1)] }),
      claim({ evidenceIds: [uid(9, 2), uid(9, 1)] }),
    ]);
    expect(r.accounts[0]!.evidenceIds).toEqual([uid(9, 1), uid(9, 2), uid(9, 3)]);
  });

  it('every row is drive_casting with the build version, and ids and hashes follow the documented definitions', () => {
    const r = roll([claim({ pieceId: PIECE })]);
    const a = r.accounts[0]!;
    const c = r.campaigns[0]!;
    expect(a).toMatchObject({ source: 'drive_casting', buildVersion: BUILD });
    expect(a.rowHash).toBe(staffAccountHash(STAFF, ACCOUNT, 'copywriter'));
    expect(a.id).toBe(staffAccountId(BUILD, a.rowHash));
    expect(c.rowHash).toBe(staffCampaignHash(STAFF, CAMP, PIECE, 'copywriter'));
    expect(c.id).toBe(staffCampaignId(BUILD, c.rowHash));
    // the hash leaves the period and the build out: a rebuild of another version keeps the hash
    expect(staffAccountHash(STAFF, ACCOUNT, null)).not.toBe(a.rowHash);
    expect(staffAccountId('fusion-v10', a.rowHash)).not.toBe(a.id);
  });
});

describe('rollUp over the real formula', () => {
  it('is deterministic and keeps every row inside the CHECKs (a synthetic drive)', () => {
    const input = generateInput(7);
    const accountIds = [...new Set(input.evidence.map((e) => e.accountId))].sort();
    const once = () =>
      accountIds.map((accountId) => {
        const claims = fuse({
          ...input,
          evidence: input.evidence.filter((e) => e.accountId === accountId),
        }).claims;
        return rollUp({ accountId, buildVersion: BUILD, claims });
      });
    const a = once();
    expect(JSON.stringify(a)).toBe(JSON.stringify(once()));
    const rows = a.flatMap((r) => [...r.accounts, ...r.campaigns]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tiers).toBeGreaterThanOrEqual(1);
      expect(row.tiers).toBeLessThanOrEqual(3);
      expect(row.evidenceIds.length).toBeGreaterThan(0);
    }
    // unique keys hold per table
    const keys = (xs: { rowHash: string }[]) =>
      new Set(xs.map((x) => x.rowHash)).size === xs.length;
    for (const r of a) {
      expect(keys(r.accounts)).toBe(true);
      expect(keys(r.campaigns)).toBe(true);
    }
  });

  it('served rows exist exactly where served claims do', () => {
    resetIds();
    const claims = fuse(
      baseInput([
        ev({
          source: 'drive_content',
          roleNorm: 'copywriter',
          confidence: 0.9,
          pieceId: uid(4, 1),
        }),
        ev({ source: 'drive_metadata', confidence: 0.3, pieceId: uid(4, 1) }),
      ]),
    ).claims;
    const r = rollUp({ accountId: ACCOUNT, buildVersion: BUILD, claims });
    const servedClaims = claims.filter((c) => c.row.withheldReason === null).length;
    expect(servedClaims).toBeGreaterThan(0);
    expect(r.accounts.filter((x) => x.withheldReason === null).length).toBeGreaterThan(0);
  });
});
