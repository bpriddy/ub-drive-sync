import { describe, expect, it } from 'vitest';
import { buildRosterIndex } from '../roster-index';
import { resolveIdentity } from '../resolve';
import { MATCH_STRENGTH, type RosterEntry } from '../types';
import { ROSTER } from './roster.fixture';

// All names, ids and dates below are synthetic. The placeholder date is arbitrary: the module
// hard-codes none, the caller passes it.
const PLACEHOLDER = '2030-01-01';

const p = (
  id: string,
  fullName: string,
  startedAt: string | null,
  isActive: boolean,
  extra: Partial<RosterEntry> = {},
): RosterEntry => ({
  staffId: id,
  fullName,
  email: null,
  startedAt,
  isActive,
  isPerson: true,
  ...extra,
});

const name = (rawName: string, evidenceDate?: string) => ({ rawName, evidenceDate });

describe('active person preferred over inactive namesakes (exact-name tiers only)', () => {
  const roster = [
    p('act-1', 'Rowan Delacroix', '2020-02-01', true),
    p('old-1', 'Rowan Delacroix', '2016-03-01', false, { endedAt: '2019-06-30' }),
    // two active namesakes plus one inactive
    p('act-2', 'Linden Marsh', '2018-01-01', true),
    p('act-3', 'Linden Marsh', '2019-01-01', true),
    p('old-2', 'Linden Marsh', '2012-01-01', false),
    // inactive only
    p('old-3', 'Corin Ashby', '2014-01-01', false),
    p('old-4', 'Corin Ashby', '2015-01-01', false),
    // alias collision
    p('act-4', 'Perrin Holt', '2021-01-01', true, { aliases: ['Perry Holt-Vance'] }),
    p('old-5', 'Perrin Holt-Vance', '2013-01-01', false, { aliases: ['Perry Holt-Vance'] }),
    // same first name family and surname, nickname tier
    p('act-5', 'Samuel Voss', '2019-01-01', true),
    p('old-6', 'Samuel Voss', '2014-01-01', false),
  ];
  const index = buildRosterIndex(roster);

  it('one active against one inactive resolves to the active person with hints', () => {
    const r = resolveIdentity(index, name('Rowan Delacroix', '2025-06-01'));
    expect(r).toMatchObject({
      personKind: 'staff',
      staffId: 'act-1',
      method: 'active_preferred',
      strength: MATCH_STRENGTH.active_preferred,
      staffIsActive: true,
      candidateStaffIds: ['old-1'],
    });
    expect(MATCH_STRENGTH.active_preferred).toBeLessThan(MATCH_STRENGTH.name_exact);
  });

  it('works with no date, and is not tied to the inactive person end date (no end-side gate)', () => {
    expect(resolveIdentity(index, name('Rowan Delacroix'))).toMatchObject({
      staffId: 'act-1',
      method: 'active_preferred',
    });
    // The inactive person left in 2019; evidence from 2025 does not remove them from the tie.
    const r = resolveIdentity(index, name('Rowan Delacroix', '2025-01-01'));
    expect(r).toMatchObject({ method: 'active_preferred', candidateStaffIds: ['old-1'] });
  });

  it('the window removes a namesake before the preference applies', () => {
    // Evidence from 2017: the active person has not started (2020), only the inactive one is plausible.
    expect(resolveIdentity(index, name('Rowan Delacroix', '2017-01-01'))).toMatchObject({
      personKind: 'staff',
      staffId: 'old-1',
      method: 'name_exact',
      staffIsActive: false,
      excludedByGate: 1,
    });
    // An inactive namesake who starts after the evidence is cut by the window: a plain exact match.
    const later = buildRosterIndex([
      p('a', 'Vesper Quill', '2015-01-01', true),
      p('b', 'Vesper Quill', '2024-01-01', false),
    ]);
    const r = resolveIdentity(later, name('Vesper Quill', '2020-01-01'));
    expect(r).toMatchObject({ staffId: 'a', method: 'name_exact', excludedByGate: 1 });
    expect(r).not.toHaveProperty('candidateStaffIds');
  });

  it('two or more active namesakes stay ambiguous, inactive ones included in the candidates', () => {
    const r = resolveIdentity(index, name('Linden Marsh'));
    expect(r).toMatchObject({
      personKind: 'quarantined',
      reason: 'ambiguous_name',
      withheldReason: 'ambiguous',
      candidateCount: 3,
    });
    if (r.personKind === 'quarantined') {
      expect([...r.candidateStaffIds].sort()).toEqual(['act-2', 'act-3', 'old-2']);
    }
  });

  it('namesakes who are all inactive stay ambiguous (interpretation of the ruling)', () => {
    expect(resolveIdentity(index, name('Corin Ashby'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'ambiguous_name',
      candidateCount: 2,
    });
  });

  it('applies to the alias tier too', () => {
    expect(resolveIdentity(index, name('Perry Holt-Vance'))).toMatchObject({
      personKind: 'staff',
      staffId: 'act-4',
      method: 'active_preferred',
      candidateStaffIds: ['old-5'],
    });
  });

  it('is never applied to weaker tiers: a nickname tie stays ambiguous', () => {
    expect(resolveIdentity(index, name('Sam Voss'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'ambiguous_name',
      method: 'nickname',
    });
    // The same pair written in full is the exact-name case.
    expect(resolveIdentity(index, name('Samuel Voss'))).toMatchObject({
      staffId: 'act-5',
      method: 'active_preferred',
    });
  });

  it('is never applied to fuzzy candidates: a typo of the pair stays quarantined', () => {
    const r = resolveIdentity(index, name('Rowan Delacroiz'));
    expect(r).toMatchObject({ personKind: 'quarantined', reason: 'fuzzy_only', method: 'fuzzy' });
    if (r.personKind === 'quarantined') {
      expect([...r.candidateStaffIds].sort()).toEqual(['act-1', 'old-1']);
    }
  });

  it('a known external with the same name still makes it a collision', () => {
    const withExternal = buildRosterIndex(roster, {
      knownExternals: [{ fullName: 'Rowan Delacroix' }],
    });
    expect(resolveIdentity(withExternal, name('Rowan Delacroix'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'staff_external_collision',
    });
  });

  it('the account gate runs before the preference', () => {
    const r = resolveIdentity(index, name('Rowan Delacroix'), {
      account: { linkedStaffIds: new Set(['old-1']) },
    });
    expect(r).toMatchObject({ staffId: 'old-1', method: 'name_exact', excludedByGate: 1 });
  });
});

describe('unknown start dates (caller-supplied placeholder)', () => {
  const roster = [
    p('imp-1', 'Ilse Brandvold', PLACEHOLDER, true),
    p('nul-1', 'Orla Penhaligon', null, true),
    p('real-1', 'Tobias Quarrie', '2024-05-01', true),
  ];

  it('without the option the placeholder is a real start date and cuts older evidence', () => {
    const index = buildRosterIndex(roster);
    expect(resolveIdentity(index, name('Ilse Brandvold', '2022-01-01'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'window_gate',
    });
  });

  it('with the option the window is not evaluated for that row', () => {
    const index = buildRosterIndex(roster, { unknownStartDates: [PLACEHOLDER] });
    const r = resolveIdentity(index, name('Ilse Brandvold', '2022-01-01'));
    expect(r).toMatchObject({
      personKind: 'staff',
      staffId: 'imp-1',
      method: 'name_exact',
      gates: { window: 'not_evaluated' },
      excludedByGate: 0,
    });
  });

  it('a null start date is treated the same way', () => {
    const index = buildRosterIndex(roster);
    expect(resolveIdentity(index, name('Orla Penhaligon', '2019-01-01'))).toMatchObject({
      personKind: 'staff',
      gates: { window: 'not_evaluated' },
    });
  });

  it('other rows keep the gate, and report it as evaluated', () => {
    const index = buildRosterIndex(roster, { unknownStartDates: [PLACEHOLDER] });
    expect(resolveIdentity(index, name('Tobias Quarrie', '2023-01-01'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'window_gate',
    });
    expect(resolveIdentity(index, name('Tobias Quarrie', '2025-01-01'))).toMatchObject({
      personKind: 'staff',
      gates: { window: 'passed' },
    });
  });

  it('a namesake pair where one start is unknown is decided by the other gate result', () => {
    const index = buildRosterIndex(
      [p('u', 'Hale Wren', PLACEHOLDER, true), p('k', 'Hale Wren', '2024-01-01', true)],
      { unknownStartDates: [PLACEHOLDER] },
    );
    // 2021: the known-start person has not started, the unknown-start one cannot be cut.
    expect(resolveIdentity(index, name('Hale Wren', '2021-01-01'))).toMatchObject({
      staffId: 'u',
      excludedByGate: 1,
    });
    // 2025: both plausible, both active: ambiguous.
    expect(resolveIdentity(index, name('Hale Wren', '2025-01-01'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'ambiguous_name',
    });
  });

  it('the account gate is independent of the start date', () => {
    const index = buildRosterIndex(roster, { unknownStartDates: [PLACEHOLDER] });
    const r = resolveIdentity(index, name('Ilse Brandvold', '2022-01-01'), {
      account: { linkedStaffIds: new Set(['nul-1']) },
    });
    expect(r).toMatchObject({ personKind: 'quarantined', reason: 'account_gate' });
  });

  it('rejects a malformed placeholder date and still rejects a malformed start date', () => {
    expect(() => buildRosterIndex(roster, { unknownStartDates: ['22/04/2026'] })).toThrow(
      RangeError,
    );
    expect(() => buildRosterIndex([p('x', 'Some Person', '22/04/2026', true)])).toThrow(RangeError);
  });
});

describe('fuzzy-only candidates are hints, never a decision', () => {
  const index = buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });

  /** Swaps two adjacent letters inside the last word, so the name is one edit away. */
  function typo(full: string): string {
    const words = full.split(' ');
    const last = words[words.length - 1] as string;
    const i = Math.floor(last.length / 2);
    const swapped = last.slice(0, i - 1) + last[i] + last[i - 1] + last.slice(i + 1);
    return [...words.slice(0, -1), swapped].join(' ');
  }

  it('a fuzzy_only result is quarantined, ambiguous, and carries its candidates', () => {
    const r = resolveIdentity(index, { rawName: 'Zofia Marek-Lindqvst' });
    expect(r).toMatchObject({
      personKind: 'quarantined',
      staffId: null,
      withheldReason: 'ambiguous',
      reason: 'fuzzy_only',
      method: 'fuzzy',
      candidateStaffIds: ['staff-01'],
      candidateCount: 1,
    });
  });

  it('no near-miss spelling of any roster name ever resolves to staff on a fuzzy or partial match', () => {
    let seen = 0;
    for (const entry of ROSTER) {
      if (!entry.isPerson || entry.fullName.split(' ').length < 2) continue;
      const r = resolveIdentity(index, { rawName: typo(entry.fullName) });
      if (r.personKind === 'staff') {
        expect(['fuzzy', 'partial']).not.toContain(r.method);
      } else if (
        r.personKind === 'quarantined' &&
        (r.method === 'fuzzy' || r.method === 'partial')
      ) {
        seen++;
        expect(r.candidateStaffIds.length).toBeGreaterThan(0);
        expect(r.candidateCount).toBeGreaterThan(0);
      }
    }
    expect(seen).toBeGreaterThan(3);
  });

  it('a fuzzy candidate failing a gate is still quarantined with its candidates', () => {
    const r = resolveIdentity(index, { rawName: 'Marta Eklnd', evidenceDate: '2019-01-01' });
    expect(r.personKind).toBe('quarantined');
    if (r.personKind === 'quarantined') expect(r.candidateStaffIds).toEqual(['staff-13']);
  });
});
