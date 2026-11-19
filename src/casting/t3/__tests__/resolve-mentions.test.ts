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
});
