import { beforeEach, describe, expect, it } from 'vitest';
import {
  fuse,
  experienceHash,
  experienceId,
  highestSeniority,
  uuidFromText,
  validationLabel,
} from '../fuse';
import { INCOMPATIBLE_ROLE_PAIRS, SINGLE_HOLDER_ROLES } from '../constants';
import type { FusedClaim, FusionEvidence, FusionOutput } from '../types';
import { ROLE_NORMS, type RoleNorm } from '../vocab';
import {
  ACCOUNT,
  CAMPAIGN,
  CAMPAIGN_LOST,
  PIECE,
  PIECE_JOB,
  STAFF_A,
  STAFF_B,
  STAFF_C,
  STAFF_FORMER,
  STAFF_NEW,
  baseInput,
  ev,
  resetIds,
  uid,
} from './fixtures';

beforeEach(resetIds);

const onPiece = { pieceId: PIECE } as const;
const t3 = (role: RoleNorm | null, p: Partial<FusionEvidence> = {}): FusionEvidence =>
  ev({ source: 'drive_content', roleNorm: role, confidence: 0.9, ...onPiece, ...p });
const t1 = (p: Partial<FusionEvidence> = {}): FusionEvidence =>
  ev({ source: 'drive_metadata', confidence: 0.3, ...onPiece, ...p });
const t2 = (p: Partial<FusionEvidence> = {}): FusionEvidence =>
  ev({ source: 'drive_activity', confidence: 0.12, ...onPiece, ...p });

const find = (out: FusionOutput, staffId: string, role: RoleNorm | null): FusedClaim | undefined =>
  out.claims.find((c) => c.row.staffId === staffId && c.row.roleNorm === role);

describe('a served claim', () => {
  it('three tiers agree: served, attributes joined, every Layer 1 row listed', () => {
    const rows = [
      t3('art_director', { periodStart: '2023-03-01', periodEnd: '2023-06-30' }),
      t1({ periodStart: '2023-01-01', periodEnd: '2023-12-31' }),
      t2(),
    ];
    const out = fuse(baseInput(rows));
    expect(out.claims).toHaveLength(1);
    const c = out.claims[0] as FusedClaim;
    expect(c.row).toMatchObject({
      staffId: STAFF_A,
      accountId: ACCOUNT,
      jobNumber: PIECE_JOB,
      campaignId: CAMPAIGN,
      pieceId: PIECE,
      roleNorm: 'art_director',
      periodStart: '2023-03-01',
      periodEnd: '2023-06-30',
      confidence: 0.938, // 1 - 0.1 * 0.7 * 0.88
      withheldReason: null,
      accountCategory: 'automotive',
      projectType: 'tv_commercial',
      outcome: 'awarded',
      budgetBand: 'large',
      fusionVersion: 'fusion-v1',
    });
    expect(c.tiers).toEqual(['T1', 'T2', 'T3']);
    expect(c.evidenceIds).toEqual(rows.map((r) => r.id).sort());
    expect(c.validation).toBe('activity_checked');
    expect(out.metrics.claims).toMatchObject({ stored: 1, served: 1, servedWithMinTiers: 1 });
  });

  it('without T2 behind it the claim is labelled not validated', () => {
    const out = fuse(baseInput([t3('copywriter'), t1()]));
    expect(out.claims[0]?.validation).toBe('not_validated');
    expect(out.claims[0]?.row.withheldReason).toBeNull();
  });

  it('activity_checked needs a dated claim AND a T2 row; the definition S7 shares', () => {
    expect(validationLabel('2023-01-01', '2023-12-31', true)).toBe('activity_checked');
    expect(validationLabel('2023-01-01', null, true)).toBe('activity_checked');
    expect(validationLabel(null, '2023-12-31', true)).toBe('activity_checked');
    expect(validationLabel(null, null, true)).toBe('not_validated'); // undated
    expect(validationLabel('2023-01-01', '2023-12-31', false)).toBe('not_validated'); // no T2
    // end to end: T2 behind an undated claim does not validate it
    const out = fuse(
      baseInput([
        t3('copywriter', { pieceId: null, campaignId: CAMPAIGN_LOST }),
        t1({ pieceId: null, campaignId: CAMPAIGN_LOST }),
        t2({ pieceId: null, campaignId: CAMPAIGN_LOST }),
      ]),
    );
    expect(out.claims[0]?.row.periodStart).toBeNull();
    expect(out.claims[0]?.tiers).toContain('T2');
    expect(out.claims[0]?.validation).toBe('not_validated');
  });

  it('project type falls back from piece to campaign, and is null when nobody supplies it', () => {
    const viaCampaign = fuse(
      baseInput([
        t3('copywriter', { pieceId: null, campaignId: CAMPAIGN }),
        t1({ pieceId: null, campaignId: CAMPAIGN }),
      ]),
    );
    expect(viaCampaign.claims[0]?.row.projectType).toBe('integrated_campaign');
    const none = fuse(
      baseInput([
        t3('copywriter', { pieceId: null, campaignId: CAMPAIGN_LOST }),
        t1({ pieceId: null, campaignId: CAMPAIGN_LOST }),
      ]),
    );
    expect(none.claims[0]?.row.projectType).toBeNull();
  });
});

describe('what is withheld, never served', () => {
  it('one strong content mention alone is unconfirmed, capped below the threshold', () => {
    const out = fuse(baseInput([t3('copywriter', { confidence: 0.99 })]));
    expect(out.claims[0]?.row).toMatchObject({ withheldReason: 'unconfirmed', confidence: 0.6 });
    expect(out.metrics.claims.withheld.unconfirmed).toBe(1);
  });

  it('presence-only claims (T1 + T2, no content row) are counted, not stored', () => {
    const out = fuse(baseInput([t1(), t2()]));
    expect(out.claims).toEqual([]);
    expect(out.metrics.claims.presenceOnlyNotStored).toBe(1);
  });

  it('a person with a stated role and presence rows gets one claim: presence folds in', () => {
    const out = fuse(baseInput([t3('copywriter'), t1(), t2()]));
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]?.evidenceIds).toHaveLength(3);
  });

  it('a content mention with no role forms a role-less claim, served when corroborated', () => {
    const out = fuse(baseInput([t3(null), t1()]));
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]?.row).toMatchObject({
      roleNorm: null,
      seniority: null,
      withheldReason: null,
    });
  });

  it('a claim with no project reference is stored unconfirmed and never served', () => {
    const rows = [
      t3('copywriter', { pieceId: null, fileId: 'a' }),
      t3('copywriter', { pieceId: null, fileId: 'b' }),
      t3('copywriter', { pieceId: null, fileId: 'c' }),
    ];
    const out = fuse(baseInput(rows));
    expect(out.claims).toHaveLength(1);
    const row = out.claims[0]?.row;
    expect(row).toMatchObject({
      withheldReason: 'unconfirmed',
      jobNumber: null,
      campaignId: null,
      pieceId: null,
    });
    expect(out.metrics.claims.projectless).toBe(1);
    expect(out.metrics.claims.served).toBe(0);
  });

  it('external, quarantined and former-staff rows never reach Layer 2', () => {
    const rows = [
      t3('art_director', {
        staffId: null,
        personKind: 'external_unresolved',
        withheldReason: 'unresolved',
        confidence: 0,
      }),
      t3('art_director', {
        staffId: null,
        personKind: 'quarantined',
        withheldReason: 'ambiguous',
        confidence: 0,
      }),
      t3('art_director', { staffId: STAFF_FORMER }),
      t1({ staffId: STAFF_FORMER }),
      t3('art_director', { staffId: uid(2, 99) }),
      t3('art_director', { withheldReason: 'conflicting' }),
    ];
    const out = fuse(baseInput(rows));
    expect(out.claims).toEqual([]);
    expect(out.metrics.staffRowsDropped).toEqual({
      notCurrent: 2,
      unknownStaff: 1,
      withheldStaffRow: 1,
    });
    expect(out.metrics.byTier.T3).toMatchObject({
      rows: 5 + 1 - 1,
      externalUnresolved: 1,
      quarantined: 1,
    });
  });

  it('an external row cannot corroborate a staff claim', () => {
    const rows = [
      t3('copywriter'),
      t1({ staffId: null, personKind: 'external_unresolved', withheldReason: 'unresolved' }),
    ];
    const out = fuse(baseInput(rows));
    expect(out.claims[0]?.row.withheldReason).toBe('unconfirmed');
    expect(out.claims[0]?.evidenceIds).toHaveLength(1);
  });

  it('every link points to a resolved, current-staff row of the same account', () => {
    const rows = [
      t3('copywriter'),
      t1(),
      t1({ staffId: null, personKind: 'quarantined', withheldReason: 'ambiguous' }),
      t3('copywriter', { staffId: STAFF_FORMER }),
    ];
    const out = fuse(baseInput(rows));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const c of out.claims) {
      for (const id of c.evidenceIds) {
        const r = byId.get(id) as FusionEvidence;
        expect(r.personKind).toBe('staff');
        expect(r.staffId).toBe(c.row.staffId);
        expect(r.accountId).toBe(c.row.accountId);
      }
    }
  });
});

describe('pitch handling', () => {
  const lost = { pieceId: null, campaignId: CAMPAIGN_LOST } as const;

  it('a strong, corroborated claim on a lost pitch is still served, with a lower confidence', () => {
    const normal = fuse(baseInput([t3('copywriter', { confidence: 0.9 }), t1()]));
    const lostOut = fuse(
      baseInput([t3('copywriter', { confidence: 0.9, ...lost }), t1({ ...lost })]),
    );
    const c = lostOut.claims[0] as FusedClaim;
    expect(c.pitchFactor).toBe(0.7);
    expect(c.row.outcome).toBe('lost');
    expect(c.row.confidence).toBe(0.708); // 1 - (1 - 0.63) * (1 - 0.21)
    expect(c.row.confidence).toBeLessThan(normal.claims[0]!.row.confidence);
    expect(c.row.withheldReason).toBeNull();
  });

  it('the same evidence that serves on a won project is withheld on a lost pitch', () => {
    const won = fuse(baseInput([t3('copywriter', { confidence: 0.7 }), t1({ confidence: 0.15 })]));
    const lostOut = fuse(
      baseInput([
        t3('copywriter', { confidence: 0.7, ...lost }),
        t1({ confidence: 0.15, ...lost }),
      ]),
    );
    expect(won.claims[0]?.row.withheldReason).toBeNull();
    expect(lostOut.claims[0]?.row.withheldReason).toBe('unconfirmed');
  });
});

describe('conflicts', () => {
  const strong = (
    staffId: string,
    role: RoleNorm,
    p: Partial<FusionEvidence> = {},
  ): FusionEvidence[] => [t3(role, { staffId, ...p }), t1({ staffId })];

  it('two people as sole executive producer on overlapping periods: both withheld as conflicting', () => {
    const rows = [
      ...strong(STAFF_A, 'executive_producer', {
        periodStart: '2023-01-01',
        periodEnd: '2023-12-31',
      }),
      ...strong(STAFF_B, 'executive_producer', {
        periodStart: '2023-06-01',
        periodEnd: '2024-03-31',
      }),
    ];
    const out = fuse(baseInput(rows));
    expect(find(out, STAFF_A, 'executive_producer')?.row.withheldReason).toBe('conflicting');
    expect(find(out, STAFF_B, 'executive_producer')?.row.withheldReason).toBe('conflicting');
    expect(out.metrics.claims.withheld.conflicting).toBe(2);
  });

  it('executive producers at different times are a hand-over, not a conflict', () => {
    const rows = [
      ...strong(STAFF_A, 'executive_producer', {
        periodStart: '2020-01-01',
        periodEnd: '2020-12-31',
      }),
      ...strong(STAFF_B, 'executive_producer', {
        periodStart: '2023-01-01',
        periodEnd: '2023-12-31',
      }),
    ];
    const out = fuse(baseInput(rows));
    expect(out.claims.map((c) => c.row.withheldReason)).toEqual([null, null]);
  });

  it('a weak, unconfirmed rival does not suppress a strong claim', () => {
    const rows = [
      ...strong(STAFF_A, 'executive_producer'),
      t3('executive_producer', { staffId: STAFF_B, confidence: 0.99 }),
    ];
    const out = fuse(baseInput(rows));
    expect(find(out, STAFF_A, 'executive_producer')?.row.withheldReason).toBeNull();
    expect(find(out, STAFF_B, 'executive_producer')?.row.withheldReason).toBe('unconfirmed');
  });

  it('`producer` is not a single-holder role: co-producers are both served', () => {
    const rows = [...strong(STAFF_A, 'producer'), ...strong(STAFF_B, 'producer')];
    const out = fuse(baseInput(rows));
    expect(out.claims.map((c) => c.row.withheldReason)).toEqual([null, null]);
  });

  it('an executive producer and a producer are different seats, not a conflict', () => {
    const rows = [...strong(STAFF_A, 'executive_producer'), ...strong(STAFF_B, 'producer')];
    const out = fuse(baseInput(rows));
    expect(out.claims.map((c) => c.row.withheldReason)).toEqual([null, null]);
  });

  it('non single-holder roles may be shared by several people', () => {
    const rows = [...strong(STAFF_A, 'copywriter'), ...strong(STAFF_B, 'copywriter')];
    expect(fuse(baseInput(rows)).claims.map((c) => c.row.withheldReason)).toEqual([null, null]);
  });

  it('one person in an incompatible role pair on a project: both claims withheld', () => {
    const rows = [...strong(STAFF_A, 'account_director'), ...strong(STAFF_A, 'art_director')];
    const out = fuse(baseInput(rows));
    expect(out.claims).toHaveLength(2);
    expect(out.claims.every((c) => c.row.withheldReason === 'conflicting')).toBe(true);
  });

  it('every listed pair conflicts, in either order of appearance', () => {
    for (const [x, y] of INCOMPATIBLE_ROLE_PAIRS) {
      for (const order of [
        [x, y],
        [y, x],
      ] as const) {
        resetIds();
        const rows = [...strong(STAFF_A, order[0]), ...strong(STAFF_A, order[1])];
        const out = fuse(baseInput(rows));
        expect(out.claims.map((c) => c.row.withheldReason)).toEqual(['conflicting', 'conflicting']);
      }
    }
  });

  it('only the pair members are withheld: a third compatible role of the person stays served', () => {
    const rows = [
      ...strong(STAFF_A, 'account_director'),
      ...strong(STAFF_A, 'art_director'),
      ...strong(STAFF_A, 'copywriter'),
    ];
    const out = fuse(baseInput(rows));
    expect(find(out, STAFF_A, 'copywriter')?.row.withheldReason).toBeNull();
    expect(find(out, STAFF_A, 'art_director')?.row.withheldReason).toBe('conflicting');
  });

  it('a pair needs BOTH claims servable: an unconfirmed second role does not withhold the first', () => {
    const rows = [
      ...strong(STAFF_A, 'account_director'),
      // art_director on another project, one tier only: unconfirmed, and on a different project anyway
      t3('art_director', { staffId: STAFF_A, pieceId: null, campaignId: CAMPAIGN_LOST }),
    ];
    const out = fuse(baseInput(rows));
    expect(find(out, STAFF_A, 'account_director')?.row.withheldReason).toBeNull();
  });

  it('neighbouring crafts are legitimately combined: strategist + copywriter, art director + designer', () => {
    for (const [x, y] of [
      ['strategist', 'copywriter'],
      ['art_director', 'designer'],
      ['copywriter', 'art_director'],
    ] as const) {
      resetIds();
      const out = fuse(baseInput([...strong(STAFF_A, x), ...strong(STAFF_A, y)]));
      expect(out.claims.map((c) => c.row.withheldReason)).toEqual([null, null]);
    }
  });

  it('`other` contradicts nothing', () => {
    const rows = [...strong(STAFF_A, 'copywriter'), ...strong(STAFF_A, 'other')];
    const out = fuse(baseInput(rows));
    expect(out.claims.every((c) => c.row.withheldReason === null)).toBe(true);
  });

  it('the incompatible pair list is short, typed, free of self-pairs and duplicates', () => {
    expect(INCOMPATIBLE_ROLE_PAIRS.length).toBeGreaterThanOrEqual(3);
    expect(INCOMPATIBLE_ROLE_PAIRS.length).toBeLessThanOrEqual(5);
    const seen = new Set<string>();
    for (const [x, y] of INCOMPATIBLE_ROLE_PAIRS) {
      expect(x).not.toBe(y);
      expect(ROLE_NORMS).toContain(x);
      expect(ROLE_NORMS).toContain(y);
      const key = [x, y].sort().join('|');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect([...SINGLE_HOLDER_ROLES]).toEqual(['executive_producer']);
  });

  it('roles on different projects never contradict', () => {
    const rows = [
      ...strong(STAFF_A, 'copywriter'),
      t3('account_manager', { staffId: STAFF_A, pieceId: null, campaignId: CAMPAIGN }),
      t1({ staffId: STAFF_A, pieceId: null, campaignId: CAMPAIGN }),
    ];
    expect(fuse(baseInput(rows)).claims.every((c) => c.row.withheldReason === null)).toBe(true);
  });
});

describe('roster window (30 days before startedAt, no end gate)', () => {
  const claimFor = (end: string) =>
    fuse(
      baseInput([
        t3('copywriter', { staffId: STAFF_NEW, periodStart: '2024-01-01', periodEnd: end }),
        t1({ staffId: STAFF_NEW }),
      ]),
    ).claims[0] as FusedClaim;

  it('a period that ends more than 30 days before the hire is a conflict', () => {
    expect(claimFor('2025-05-01').row.withheldReason).toBe('conflicting'); // startedAt 2025-06-01, limit 2025-05-02
  });

  it('the tolerance edge is inclusive', () => {
    expect(claimFor('2025-05-02').row.withheldReason).toBeNull();
  });

  it('there is no end gate: a long-past hire date never excludes a later period', () => {
    const c = fuse(
      baseInput([
        t3('copywriter', { staffId: STAFF_B, periodStart: '2030-01-01', periodEnd: '2030-06-01' }),
        t1({ staffId: STAFF_B }),
      ]),
    ).claims[0] as FusedClaim;
    expect(c.row.withheldReason).toBeNull();
  });

  it('an unknown hire date skips the check', () => {
    const c = fuse(
      baseInput([
        t3('copywriter', { staffId: STAFF_C, periodStart: '1999-01-01', periodEnd: '1999-06-01' }),
        t1({ staffId: STAFF_C }),
      ]),
    ).claims[0] as FusedClaim;
    expect(c.row.withheldReason).toBeNull();
  });
});

describe('seniority: the highest wins', () => {
  it('highestSeniority orders junior < senior < lead < director < executive', () => {
    expect(highestSeniority(['senior', 'director', null, 'junior'])).toBe('director');
    expect(highestSeniority([null, null])).toBeNull();
    expect(highestSeniority(['executive', 'lead'])).toBe('executive');
  });

  it('several values on one project and role merge to the highest; null rows do not dilute it', () => {
    const rows = [
      t3('copywriter', { seniority: 'senior', fileId: 'a' }),
      t3('copywriter', { seniority: 'lead', fileId: 'b' }),
      t3('copywriter', { seniority: null, fileId: 'c' }),
      t1(),
    ];
    const out = fuse(baseInput(rows));
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]?.row.seniority).toBe('lead');
  });

  it('seniority of one role does not leak to another role of the same person', () => {
    const rows = [
      t3('copywriter', { seniority: 'director' }),
      t3('art_director', { seniority: null }),
      t1(),
    ];
    const out = fuse(baseInput(rows));
    expect(find(out, STAFF_A, 'copywriter')?.row.seniority).toBe('director');
    expect(find(out, STAFF_A, 'art_director')?.row.seniority).toBeNull();
  });
});

describe('period', () => {
  it('T2 days are never a period', () => {
    const rows = [
      t3('copywriter', { pieceId: null, jobNumber: 'NOCAMPAIGN1' }),
      t2({
        pieceId: null,
        jobNumber: 'NOCAMPAIGN1',
        periodStart: '2024-01-01',
        periodEnd: '2024-01-31',
      }),
    ];
    const c = fuse(baseInput(rows)).claims[0] as FusedClaim;
    expect(c.row.periodStart).toBeNull();
    expect(c.row.periodEnd).toBeNull();
  });

  it('a person with no stated period takes the project period from T1 rows of anyone', () => {
    const rows = [
      t3('copywriter'),
      t1({ staffId: STAFF_B, periodStart: '2022-02-01', periodEnd: '2022-09-30' }),
      t1({ periodStart: '2022-03-01', periodEnd: '2022-08-31' }),
    ];
    const c = find(fuse(baseInput(rows)), STAFF_A, 'copywriter') as FusedClaim;
    expect([c.row.periodStart, c.row.periodEnd]).toEqual(['2022-02-01', '2022-09-30']);
  });

  it('falls back to the campaign dates, then to null', () => {
    const viaCampaign = fuse(baseInput([t3('copywriter'), t1()])).claims[0] as FusedClaim;
    expect([viaCampaign.row.periodStart, viaCampaign.row.periodEnd]).toEqual([
      '2023-02-01',
      '2023-12-31',
    ]);
    const none = fuse(
      baseInput([
        t3('copywriter', { pieceId: null, campaignId: CAMPAIGN_LOST }),
        t1({ pieceId: null, campaignId: CAMPAIGN_LOST }),
      ]),
    ).claims[0] as FusedClaim;
    expect([none.row.periodStart, none.row.periodEnd]).toEqual([null, null]);
  });

  it('the span of several stated periods is the claim period (never one file date)', () => {
    const rows = [
      t3('copywriter', { fileId: 'a', periodStart: '2021-01-01', periodEnd: '2021-12-31' }),
      t3('copywriter', { fileId: 'b', periodStart: '2022-06-01', periodEnd: '2022-12-31' }),
      t1(),
    ];
    const c = fuse(baseInput(rows)).claims[0] as FusedClaim;
    expect([c.row.periodStart, c.row.periodEnd]).toEqual(['2021-01-01', '2022-12-31']);
  });
});

describe('supersede by extractor_version', () => {
  it('only the newest version of a file counts', () => {
    const rows = [
      t3('copywriter', { fileId: 'doc', extractorVersion: 't3-v1' }),
      t3('art_director', { fileId: 'doc', extractorVersion: 't3-v2' }),
      t1(),
    ];
    const out = fuse(baseInput(rows));
    expect(out.claims.map((c) => c.row.roleNorm)).toEqual(['art_director']);
    expect(out.metrics.superseded).toBe(1);
  });
});

describe('hash and ids', () => {
  it('the hash covers staff, project, role and period start', () => {
    const base = {
      staffId: STAFF_A,
      projectKey: `piece:${PIECE}`,
      roleNorm: 'copywriter' as const,
      periodStart: '2023-01-01',
    };
    const h = experienceHash(base);
    expect(experienceHash({ ...base })).toBe(h);
    expect(experienceHash({ ...base, staffId: STAFF_B })).not.toBe(h);
    expect(experienceHash({ ...base, projectKey: 'campaign:x' })).not.toBe(h);
    expect(experienceHash({ ...base, roleNorm: null })).not.toBe(h);
    expect(experienceHash({ ...base, periodStart: null })).not.toBe(h);
  });

  it('ids are deterministic v5-shaped UUIDs', () => {
    const id = experienceId('fusion-v1', 'abc');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(experienceId('fusion-v1', 'abc')).toBe(id);
    expect(experienceId('fusion-v2', 'abc')).not.toBe(id);
    expect(uuidFromText('x')).toBe(uuidFromText('x'));
  });

  it('a duplicate Layer 1 id is counted once', () => {
    const a = t3('copywriter');
    const out = fuse(baseInput([a, { ...a }, t1()]));
    expect(out.metrics.duplicateIds).toBe(1);
    expect(out.claims[0]?.evidenceIds).toHaveLength(2);
  });
});

describe('proxy metrics (counts, never precision or recall)', () => {
  it('cross-document agreement, T2 agreement inside the activity horizon, validation by year', () => {
    const input = baseInput([
      // A: two documents, T1, T2, dated 2026: inside the horizon, with T2.
      t3('copywriter', { fileId: 'a1', periodStart: '2026-01-01', periodEnd: '2026-03-31' }),
      t3('copywriter', { fileId: 'a2', periodStart: '2026-01-01', periodEnd: '2026-03-31' }),
      t1(),
      t2(),
      // B: one document, T1, dated 2022: before the horizon.
      t3('copywriter', {
        staffId: STAFF_B,
        fileId: 'b1',
        periodStart: '2022-01-01',
        periodEnd: '2022-03-31',
      }),
      t1({ staffId: STAFF_B }),
    ]);
    input.activityStartByAccount = new Map([[ACCOUNT, '2025-11-01']]);
    const m = fuse(input).metrics;
    expect(m.crossDocumentAgreement).toEqual({ claims: 2, withTwoFiles: 1, share: 0.5 });
    expect(m.t2Agreement).toEqual({ claims: 1, withT2: 1, share: 1 });
    expect(m.servedByYear).toEqual({
      '2022': { activity_checked: 0, not_validated: 1 },
      '2026': { activity_checked: 1, not_validated: 0 },
    });
    expect(m.claims.servedWithMinTiers).toBe(m.claims.served);
  });

  it('T2 agreement is empty without an activity horizon', () => {
    const m = fuse(baseInput([t3('copywriter'), t1()])).metrics;
    expect(m.t2Agreement).toEqual({ claims: 0, withT2: 0, share: null });
  });

  it('per-tier shares of resolved, external and quarantined rows', () => {
    const m = fuse(
      baseInput([
        t3('copywriter'),
        t3('copywriter', {
          staffId: null,
          personKind: 'external_unresolved',
          withheldReason: 'unresolved',
        }),
        t3('copywriter', { staffId: null, personKind: 'quarantined', withheldReason: 'ambiguous' }),
        t1(),
      ]),
    ).metrics;
    expect(m.byTier.T3).toMatchObject({ rows: 3, staff: 1, externalUnresolved: 1, quarantined: 1 });
    expect(m.byTier.T1).toMatchObject({ rows: 1, staff: 1 });
  });

  it('coverage counts projects with a resolved person and with a served claim', () => {
    const m = fuse(
      baseInput([
        t3('copywriter'),
        t1({ periodStart: '2023-01-01', periodEnd: '2023-12-31' }),
        // a second project seen only through an external person
        t3('copywriter', {
          pieceId: null,
          campaignId: CAMPAIGN_LOST,
          staffId: null,
          personKind: 'external_unresolved',
          withheldReason: 'unresolved',
        }),
      ]),
    ).metrics;
    expect(m.coverage[`${ACCOUNT}|2023`]).toEqual({
      projects: 1,
      withResolvedPerson: 1,
      withServedClaim: 1,
    });
    expect(m.coverage[`${ACCOUNT}|unknown`]).toEqual({
      projects: 1,
      withResolvedPerson: 0,
      withServedClaim: 0,
    });
  });
});
