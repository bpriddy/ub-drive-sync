import { describe, expect, it } from 'vitest';
import { compareExtractorVersion, supersedeByVersion } from '../supersede';
import { createProjectResolver } from '../project';
import { addDays, campaignPeriod, deriveClaimPeriod, envelope, periodsOverlap } from '../period';
import {
  ACCOUNT,
  CAMPAIGN,
  CAMPAIGN_LOST,
  OTHER_ACCOUNT,
  PIECE,
  PIECE_JOB,
  campaigns,
  ev,
  pieces,
  resetIds,
  uid,
} from './fixtures';

describe('compareExtractorVersion', () => {
  it('compares digit runs as numbers', () => {
    expect(compareExtractorVersion('t3-v10', 't3-v9')).toBe(1);
    expect(compareExtractorVersion('t3-v2', 't3-v10')).toBe(-1);
    expect(compareExtractorVersion('t3-v2', 't3-v2')).toBe(0);
  });

  it('is a total order: antisymmetric and transitive on a sample', () => {
    const vs = ['a-v1', 'a-v2', 'a-v10', 'a-v1.2', 'b-v1', 't3-mentions-v1', 't3-mentions-v1b', ''];
    for (const a of vs)
      for (const b of vs)
        expect(compareExtractorVersion(a, b) + 0).toBe(-compareExtractorVersion(b, a) + 0);
    const sorted = [...vs].sort(compareExtractorVersion);
    for (let i = 0; i + 1 < sorted.length; i++) {
      expect(
        compareExtractorVersion(sorted[i] as string, sorted[i + 1] as string),
      ).toBeLessThanOrEqual(0);
    }
  });
});

describe('supersedeByVersion', () => {
  it('keeps only the newest version of a (source, file)', () => {
    resetIds();
    const old = ev({ source: 'drive_content', fileId: 'doc', extractorVersion: 't3-v1' });
    const fresh = ev({ source: 'drive_content', fileId: 'doc', extractorVersion: 't3-v2' });
    const out = supersedeByVersion([old, fresh]);
    expect(out.kept).toEqual([fresh]);
    expect(out.superseded).toBe(1);
  });

  it('a partial re-scan replaces only the files it reached', () => {
    resetIds();
    const a1 = ev({ source: 'drive_content', fileId: 'a', extractorVersion: 't3-v1' });
    const a2 = ev({ source: 'drive_content', fileId: 'a', extractorVersion: 't3-v2' });
    const b1 = ev({ source: 'drive_content', fileId: 'b', extractorVersion: 't3-v1' });
    const out = supersedeByVersion([a1, a2, b1]);
    expect(out.kept.map((r) => r.id).sort()).toEqual([a2.id, b1.id].sort());
  });

  it('different sources of one file do not supersede each other', () => {
    resetIds();
    const t1 = ev({ source: 'drive_metadata', fileId: 'x', extractorVersion: 't1-v1' });
    const t3 = ev({ source: 'drive_content', fileId: 'x', extractorVersion: 't3-v1' });
    expect(supersedeByVersion([t1, t3]).superseded).toBe(0);
  });

  it('keeps all rows of the winning version (several mentions in one file)', () => {
    resetIds();
    const rows = [1, 2, 3].map(() =>
      ev({ source: 'drive_content', fileId: 'doc', extractorVersion: 't3-v2' }),
    );
    expect(supersedeByVersion(rows).kept).toHaveLength(3);
  });
});

describe('project resolver ladder', () => {
  const resolve = createProjectResolver(campaigns(), pieces());

  it('piece id wins and fills job, campaign and piece', () => {
    resetIds();
    const r = resolve(ev({ source: 'drive_metadata', pieceId: PIECE }));
    expect(r).toMatchObject({
      key: `piece:${PIECE}`,
      jobNumber: PIECE_JOB,
      campaignId: CAMPAIGN,
      pieceId: PIECE,
    });
  });

  it('a job number that names a catalog piece resolves to the piece (T2 vs T1 agree)', () => {
    resetIds();
    const a = resolve(ev({ source: 'drive_activity', jobNumber: PIECE_JOB }));
    const b = resolve(
      ev({ source: 'drive_metadata', pieceId: PIECE, jobNumber: PIECE_JOB, campaignId: CAMPAIGN }),
    );
    expect(a.key).toBe(b.key);
  });

  it('an unknown job number keeps a per-account job key', () => {
    resetIds();
    expect(resolve(ev({ source: 'drive_metadata', jobNumber: 'UNKNOWN1' })).key).toBe(
      `job:${ACCOUNT}:UNKNOWN1`,
    );
  });

  it('a campaign id alone resolves to the campaign', () => {
    resetIds();
    expect(resolve(ev({ source: 'drive_content', campaignId: CAMPAIGN_LOST })).key).toBe(
      `campaign:${CAMPAIGN_LOST}`,
    );
  });

  it('a name key counts for T1 only', () => {
    resetIds();
    expect(resolve(ev({ source: 'drive_metadata', location: 'name:launch-plan' })).key).toBe(
      `name:${ACCOUNT}:launch-plan`,
    );
    expect(resolve(ev({ source: 'drive_content', location: 'name:launch-plan' })).key).toBeNull();
  });

  it('ids the catalog does not know are ignored', () => {
    resetIds();
    const r = resolve(ev({ source: 'drive_content', campaignId: uid(3, 99), pieceId: uid(4, 99) }));
    expect(r.key).toBeNull();
    expect(r.campaignId).toBeNull();
    expect(r.pieceId).toBeNull();
  });

  it('a campaign of another account never lends itself to this account', () => {
    resetIds();
    const r = resolve(
      ev({ source: 'drive_content', accountId: OTHER_ACCOUNT, campaignId: CAMPAIGN }),
    );
    expect(r.key).toBeNull();
    expect(r.campaign).toBeNull();
  });

  it('no reference at all: no project', () => {
    resetIds();
    expect(resolve(ev({ source: 'drive_content' })).key).toBeNull();
  });
});

describe('claim period', () => {
  it('envelope of rows that have both dates', () => {
    expect(
      envelope([
        { periodStart: '2022-03-01', periodEnd: '2022-05-31' },
        { periodStart: '2021-11-01', periodEnd: '2022-01-31' },
        { periodStart: null, periodEnd: '2030-01-01' },
      ]),
    ).toEqual({ start: '2021-11-01', end: '2022-05-31' });
    expect(envelope([{ periodStart: null, periodEnd: null }])).toBeNull();
  });

  it('content period beats project period beats campaign dates', () => {
    resetIds();
    const content = ev({
      source: 'drive_content',
      periodStart: '2022-01-01',
      periodEnd: '2022-06-30',
    });
    const t1 = ev({ source: 'drive_metadata', periodStart: '2021-01-01', periodEnd: '2021-12-31' });
    const campaign = campaigns()[0]!;
    expect(
      deriveClaimPeriod({ contentRows: [content], projectT1Rows: [t1], campaign }),
    ).toMatchObject({ start: '2022-01-01', basis: 'content' });
    expect(deriveClaimPeriod({ contentRows: [], projectT1Rows: [t1], campaign })).toMatchObject({
      start: '2021-01-01',
      basis: 'project',
    });
    expect(deriveClaimPeriod({ contentRows: [], projectT1Rows: [], campaign })).toMatchObject({
      start: '2023-02-01',
      end: '2023-12-31',
      basis: 'campaign',
    });
    expect(deriveClaimPeriod({ contentRows: [], projectT1Rows: [], campaign: null })).toEqual({
      start: null,
      end: null,
      basis: 'none',
    });
  });

  it('a campaign with no start gives no period; an end before the start is dropped', () => {
    expect(campaignPeriod({ awardedAt: null, liveAt: null, endsAt: '2023-01-01' })).toBeNull();
    expect(campaignPeriod({ awardedAt: '2023-05-01', liveAt: null, endsAt: '2023-01-01' })).toEqual(
      { start: '2023-05-01', end: null },
    );
  });

  it('addDays crosses month and year ends', () => {
    expect(addDays('2024-03-01', -30)).toBe('2024-01-31');
    expect(addDays('2024-01-10', -30)).toBe('2023-12-11');
  });

  it('overlap treats an unknown bound as overlapping', () => {
    expect(
      periodsOverlap(
        { start: '2022-01-01', end: '2022-06-30' },
        { start: '2022-06-30', end: '2022-12-31' },
      ),
    ).toBe(true);
    expect(
      periodsOverlap(
        { start: '2022-01-01', end: '2022-06-29' },
        { start: '2022-06-30', end: '2022-12-31' },
      ),
    ).toBe(false);
    expect(
      periodsOverlap({ start: null, end: null }, { start: '2022-06-30', end: '2022-12-31' }),
    ).toBe(true);
    expect(
      periodsOverlap(
        { start: '2022-01-01', end: null },
        { start: '2030-01-01', end: '2030-02-01' },
      ),
    ).toBe(true);
  });
});
