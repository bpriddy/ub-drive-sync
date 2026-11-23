import { beforeAll, describe, expect, it } from 'vitest';
import { buildRosterIndex, type RosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import type { GroundedMention } from '../ground';
import { mentionsToDrafts, newResolveCounts } from '../resolve-mentions';

let index: RosterIndex;
beforeAll(() => {
  index = buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });
});

const NOW = new Date('2026-11-19T00:00:00Z');
const doc = {
  fileId: 'file-1',
  accountId: 'acct-1',
  createdTime: '2025-02-01T00:00:00Z',
  projectRef: { jobNumber: 'JOB-7', campaignId: null, pieceId: null },
};
const m = (over: Partial<GroundedMention> & { rawName: string }): GroundedMention => ({
  rawRole: null,
  quote: null,
  isClientSide: false,
  periodText: null,
  location: null,
  ...over,
});
const run = (
  mentions: GroundedMention[],
  context?: Parameters<typeof mentionsToDrafts>[0]['context'],
) => {
  const counts = newResolveCounts();
  const drafts = mentionsToDrafts(
    {
      candidate: doc,
      docType: 'credits_or_team',
      mentions,
      index,
      context,
      extractorVersion: 'v',
      contentVersion: 'cell-1',
      now: NOW,
    },
    counts,
  );
  return { drafts, counts };
};

describe('mentionsToDrafts', () => {
  it('collapses a repeated claim and counts it', () => {
    const { drafts, counts } = run([
      m({ rawName: 'Jürgen Falkenrath', rawRole: 'Creative Director' }),
      m({ rawName: ' JÜRGEN  Falkenrath ', rawRole: 'creative director' }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(counts.duplicateClaims).toBe(1);
  });

  it('keeps the same person in two roles as two claims', () => {
    const { drafts } = run([
      m({ rawName: 'Jürgen Falkenrath', rawRole: 'Creative Director' }),
      m({ rawName: 'Jürgen Falkenrath', rawRole: 'Copywriter' }),
    ]);
    expect(drafts.map((d) => d.row.role_norm)).toEqual(['creative_director', 'copywriter']);
  });

  it('two staff with one name stay quarantined with their candidates in meta, never a guess', () => {
    const { drafts, counts } = run([m({ rawName: 'Taylor Brennan', rawRole: 'Producer' })]);
    expect(drafts[0]?.row).toMatchObject({
      person_kind: 'quarantined',
      staff_id: null,
      withheld_reason: 'ambiguous',
      confidence: 0,
    });
    expect([...(drafts[0]?.meta.candidateStaffIds ?? [])].sort()).toEqual(['staff-08', 'staff-09']);
    expect(counts.byReason).toEqual({ ambiguous_name: 1 });
  });

  it('the account gate comes from the caller: a staff member outside the set is withheld', () => {
    const inside = run([m({ rawName: 'Jürgen Falkenrath' })], {
      account: { linkedStaffIds: new Set(['staff-05']) },
    });
    expect(inside.drafts[0]?.row.person_kind).toBe('staff');
    const outside = run([m({ rawName: 'Jürgen Falkenrath' })], {
      account: { linkedStaffIds: new Set(['staff-01']) },
    });
    expect(outside.drafts[0]?.row).toMatchObject({ person_kind: 'quarantined', staff_id: null });
    expect(outside.counts.byReason).toEqual({ account_gate: 1 });
  });

  it('role fields: raw kept, vocabulary and seniority split; no role means nulls', () => {
    const { drafts } = run([
      m({ rawName: 'Zofia Marek-Lindqvist', rawRole: 'Sr. Copywriter' }),
      m({ rawName: 'Alexander Voronin', rawRole: null }),
      m({ rawName: 'Jürgen Falkenrath', rawRole: 'Chief Wizard' }),
    ]);
    expect(drafts[0]?.row).toMatchObject({
      role_raw: 'Sr. Copywriter',
      role_norm: 'copywriter',
      seniority: 'senior',
    });
    expect(drafts[1]?.row).toMatchObject({ role_raw: null, role_norm: null, seniority: null });
    expect(drafts[2]?.row).toMatchObject({ role_raw: 'Chief Wizard', role_norm: 'other' });
  });

  it('file, account and project refs come from the document, and every row is a drive_content row', () => {
    const { drafts } = run([
      m({ rawName: 'Alexander Voronin', rawRole: 'Producer', location: 'slide 3' }),
    ]);
    expect(drafts[0]?.row).toMatchObject({
      file_id: 'file-1',
      account_id: 'acct-1',
      job_number: 'JOB-7',
      source: 'drive_content',
      location: 'slide 3',
      extractor_version: 'v',
    });
    expect(drafts[0]?.row.claim_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('with no period the window uses the file createdTime day: a person who joined later is gated', () => {
    // 'Sam Ashworth' joined 2024-02-01; the file was created 2025, so the gate lets it through.
    const ok = run([m({ rawName: 'Sam Ashworth' })]);
    expect(ok.drafts[0]?.row.person_kind).toBe('staff');
    // a work period of 2023 predates a 2024 start by more than the tolerance
    const gated = run([m({ rawName: 'Sam Ashworth', periodText: '2023' })]);
    expect(gated.drafts[0]?.row.person_kind).not.toBe('staff');
  });

  it('a period in the future is unknown: the row is still emitted with NULL period, and the gate falls back to createdTime', () => {
    // staff-07 started 2021-01-11. File created in 2019, text claims 2027.
    const old = { ...doc, createdTime: '2019-06-01T00:00:00Z' };
    const counts = newResolveCounts();
    const drafts = mentionsToDrafts(
      {
        candidate: old,
        docType: 'plan',
        mentions: [m({ rawName: 'Yuriy Kovalenko', rawRole: 'Producer', periodText: '2027' })],
        index,
        extractorVersion: 'v',
        contentVersion: 'cell-1',
        now: NOW,
      },
      counts,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.row).toMatchObject({ period_start: null, period_end: null });
    // the future date no longer reaches the gate: the 2019 file date does, and gates the person
    expect(drafts[0]?.row.person_kind).toBe('quarantined');
    expect(counts.byReason).toEqual({ window_gate: 1 });
  });

  it('a range spanning the present is stored clamped to the run date, and the gate sees the clamped end', () => {
    const { drafts } = run([
      m({ rawName: 'Yuriy Kovalenko', rawRole: 'Producer', periodText: '2018 - 2030' }),
    ]);
    expect(drafts[0]?.row).toMatchObject({
      person_kind: 'staff',
      period_start: '2018-01-01',
      period_end: '2026-11-19',
    });
  });

  it('claim_hash does not move with the run day (it is built on the stated period)', () => {
    const at = (iso: string, text: string) => {
      const counts = newResolveCounts();
      return mentionsToDrafts(
        {
          candidate: doc,
          docType: 'x',
          mentions: [m({ rawName: 'Alexander Voronin', rawRole: 'Producer', periodText: text })],
          index,
          extractorVersion: 'v',
          contentVersion: 'cell-1',
          now: new Date(iso),
        },
        counts,
      )[0]?.row;
    };
    const day1 = at('2026-11-19T00:00:00Z', '2025-2028');
    const day2 = at('2026-12-24T00:00:00Z', '2025-2028');
    expect(day1?.period_end).toBe('2026-11-19');
    expect(day2?.period_end).toBe('2026-12-24');
    expect(day1?.claim_hash).toBe(day2?.claim_hash);
    const f1 = at('2026-11-19T00:00:00Z', '2027');
    const f2 = at('2027-03-01T00:00:00Z', '2027');
    expect(f1?.period_start).toBeNull();
    expect(f2?.period_start).toBe('2027-01-01');
    expect(f1?.claim_hash).toBe(f2?.claim_hash);
  });

  it('claim_hash carries the content version: same claim, same version = same hash; new version = new hash', () => {
    const at = (contentVersion: string) => {
      const counts = newResolveCounts();
      return mentionsToDrafts(
        {
          candidate: doc,
          docType: 'x',
          mentions: [m({ rawName: 'Alexander Voronin', rawRole: 'Producer', location: 'slide 2' })],
          index,
          extractorVersion: 'v',
          contentVersion,
          now: NOW,
        },
        counts,
      )[0]?.row;
    };
    expect(at('cell-1')?.claim_hash).toBe(at('cell-1')?.claim_hash);
    expect(at('cell-1')?.claim_hash).not.toBe(at('cell-2')?.claim_hash);
    // Nothing else about the row moves with it.
    expect({ ...at('cell-1'), claim_hash: '' }).toEqual({ ...at('cell-2'), claim_hash: '' });
  });
});
