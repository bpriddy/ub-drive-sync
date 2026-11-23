import { beforeAll, describe, expect, it } from 'vitest';
import { buildRosterIndex, type RosterIndex } from '../roster-index';
import { resolveIdentity } from '../resolve';
import type { IdentityResolution, KnownExternal, Mention, RosterEntry } from '../types';
import { ROSTER } from './roster.fixture';

const DOMAINS = ['agency.example'];
const EXTERNALS: KnownExternal[] = [
  { fullName: 'Marta Eklund', email: 'marta@client.example' },
  { fullName: 'Pavel Orlovsky' },
];

let index: RosterIndex;
beforeAll(() => {
  index = buildRosterIndex(ROSTER, { agencyEmailDomains: DOMAINS });
});

const name = (rawName: string, extra: Partial<Mention> = {}): Mention => ({ rawName, ...extra });

function staffId(r: IdentityResolution): string | null {
  return r.personKind === 'staff' ? r.staffId : null;
}

describe('email', () => {
  it('an exact roster email resolves, whatever the case or wrapping', () => {
    for (const raw of [
      'user02@agency.example',
      'USER02@Agency.Example',
      'mailto:user02@agency.example',
    ]) {
      const r = resolveIdentity(index, { rawName: 'Alexander Voronin', rawEmail: raw });
      expect(r).toMatchObject({
        personKind: 'staff',
        staffId: 'staff-02',
        method: 'email',
        strength: 1,
      });
    }
  });

  it('an email in the name field is treated as an email', () => {
    const r = resolveIdentity(index, name('zofia.marek-lindqvist@agency.example'));
    expect(r).toMatchObject({ personKind: 'staff', staffId: 'staff-01', method: 'email' });
  });

  it('an agency address missing from the roster is a former employee, not a lookalike', () => {
    const r = resolveIdentity(index, {
      rawName: 'Taylor Brennan',
      rawEmail: 'someone.else@agency.example',
    });
    expect(r).toMatchObject({ personKind: 'external_unresolved', reason: 'unknown_agency_email' });
  });

  it('a client-domain address with a staff name is external', () => {
    const r = resolveIdentity(index, {
      rawName: 'Zofia Marek-Lindqvist',
      rawEmail: 'z@client.example',
    });
    expect(r).toMatchObject({ personKind: 'external_unresolved', reason: 'external_email' });
  });

  it('an address on the known-external list is external', () => {
    const withExternals = buildRosterIndex(ROSTER, {
      agencyEmailDomains: DOMAINS,
      knownExternals: EXTERNALS,
    });
    const r = resolveIdentity(withExternals, {
      rawName: 'Marta Eklund',
      rawEmail: 'marta@client.example',
    });
    expect(r).toMatchObject({ personKind: 'external_unresolved', reason: 'known_external' });
  });

  it('an email hit that contradicts the written name is quarantined', () => {
    const r = resolveIdentity(index, {
      rawName: 'Pavel Orlovsky',
      rawEmail: 'user02@agency.example',
    });
    expect(r).toMatchObject({ personKind: 'quarantined', reason: 'email_name_conflict' });
  });

  it('without configured domains an unknown email falls through to the name', () => {
    const open = buildRosterIndex(ROSTER);
    const r = resolveIdentity(open, {
      rawName: 'Zofia Marek-Lindqvist',
      rawEmail: 'x@elsewhere.example',
    });
    expect(r).toMatchObject({ personKind: 'staff', staffId: 'staff-01', method: 'name_exact' });
  });
});

describe('name shapes: diacritics, order, punctuation', () => {
  it.each([
    ['Jose Alvarez-Quintero', 'staff-04'],
    ['JOSÉ ÁLVAREZ QUINTERO', 'staff-04'],
    ['Alvarez-Quintero, Jose', 'staff-04'],
    ['Quintero Alvarez Jose', 'staff-04'],
    ['Dr. José Álvarez-Quintero Jr.', 'staff-04'],
    ['Lukasz Wieczorkiewicz', 'staff-06'],
    ['Łukasz Wieczorkiewicz', 'staff-06'],
    ['Niamh ODwyer', 'staff-17'],
    ["Niamh O'Dwyer", 'staff-17'],
    ['niamh o dwyer', 'staff-17'],
  ])('%s -> %s by exact name', (raw, id) => {
    const r = resolveIdentity(index, name(raw));
    expect(r).toMatchObject({ personKind: 'staff', staffId: id, method: 'name_exact' });
  });

  it.each(['Juergen Falkenrath', 'Jürgen Falkenrath', 'Jurgen Falkenrath'])(
    'umlaut spelling %s resolves',
    (raw) => {
      expect(staffId(resolveIdentity(index, name(raw)))).toBe('staff-05');
    },
  );

  it('a dropped or extra middle name resolves by first and last name', () => {
    expect(resolveIdentity(index, name('Anna Kowalczyk'))).toMatchObject({
      staffId: 'staff-14',
      method: 'name_first_last',
    });
    expect(resolveIdentity(index, name('Zofia Maria Marek-Lindqvist'))).toMatchObject({
      staffId: 'staff-01',
      method: 'name_first_last',
    });
  });

  it('a roster alias resolves as an alias', () => {
    expect(resolveIdentity(index, name('Marta Svensson'))).toMatchObject({
      staffId: 'staff-13',
      method: 'alias',
      strength: 0.9,
    });
  });
});

describe('transliteration', () => {
  it.each(['Юрий Коваленко', 'Iurii Kovalenko', 'Yuriy Kovalenko', 'Jurij Kovalenko'])(
    '%s resolves to the Latin-script row by the transliteration tier',
    (raw) => {
      expect(resolveIdentity(index, name(raw))).toMatchObject({
        personKind: 'staff',
        staffId: 'staff-07',
        method: 'translit',
      });
    },
  );
});

describe('nicknames and initials', () => {
  it('a nickname that fits two long forms is ambiguous, never picked', () => {
    const r = resolveIdentity(index, name('Sasha Voronin'));
    expect(r).toMatchObject({
      personKind: 'quarantined',
      reason: 'ambiguous_name',
      method: 'nickname',
    });
    if (r.personKind === 'quarantined')
      expect([...r.candidateStaffIds].sort()).toEqual(['staff-02', 'staff-03']);
  });

  it('the long form resolves exactly; its nickname sibling does not interfere', () => {
    expect(resolveIdentity(index, name('Alexander Voronin'))).toMatchObject({
      staffId: 'staff-02',
      method: 'name_exact',
    });
    expect(resolveIdentity(index, name('Alexandra Voronin'))).toMatchObject({
      staffId: 'staff-03',
      method: 'name_exact',
    });
  });

  it('a nickname resolves when the window leaves one candidate', () => {
    const r = resolveIdentity(index, name('Alex Voronin', { evidenceDate: '2019-05-01' }));
    expect(r).toMatchObject({ staffId: 'staff-02', method: 'nickname', excludedByGate: 1 });
  });

  it('a quoted nickname is only a fallback spelling', () => {
    // Written name resolves on its own: the nickname must not add a second candidate.
    expect(staffId(resolveIdentity(index, name('Alexander "Sasha" Voronin')))).toBe('staff-02');
    expect(staffId(resolveIdentity(index, name('Aleksandr (Sasha) Voronin')))).toBe('staff-02');
  });

  it('an initial and a surname resolve only when exactly one staff fits', () => {
    expect(resolveIdentity(index, name('Z. Marek-Lindqvist'))).toMatchObject({
      staffId: 'staff-01',
      method: 'initial',
      strength: 0.6,
    });
    expect(resolveIdentity(index, name('J. Wexford'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'ambiguous_name',
    });
  });
});

describe('fuzzy and partial names only generate candidates', () => {
  it('a one-letter typo is quarantined with the candidate, not resolved', () => {
    const r = resolveIdentity(index, name('Zofia Marek-Lindqvst'));
    expect(r).toMatchObject({ personKind: 'quarantined', reason: 'fuzzy_only', method: 'fuzzy' });
    if (r.personKind === 'quarantined') expect(r.candidateStaffIds).toEqual(['staff-01']);
  });

  it('a first name alone is quarantined, with every candidate listed', () => {
    expect(resolveIdentity(index, name('Zofia'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'partial_name',
      candidateCount: 1,
    });
    expect(resolveIdentity(index, name('Taylor'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'partial_name',
      candidateCount: 2,
    });
  });

  it('a first name that fits many staff says nothing', () => {
    const crowd: RosterEntry[] = Array.from({ length: 7 }, (_, i) => ({
      staffId: `c-${i}`,
      fullName: `Chris Surname${String.fromCharCode(97 + i)}`,
      email: null,
      startedAt: '2020-01-01',
      isActive: true,
      isPerson: true,
    }));
    expect(resolveIdentity(buildRosterIndex(crowd), name('Chris'))).toMatchObject({
      personKind: 'external_unresolved',
      reason: 'generic_name',
    });
  });
});

describe('employment window gate', () => {
  it('two staff with the same name: the one not yet employed is excluded', () => {
    const r = resolveIdentity(index, name('Taylor Brennan', { evidenceDate: '2021-06-01' }));
    expect(r).toMatchObject({ personKind: 'staff', staffId: 'staff-08', excludedByGate: 1 });
  });

  it('two staff with the same name stay ambiguous when both fit or the date is unknown', () => {
    for (const evidenceDate of ['2025-06-01', undefined, null, 'not-a-date']) {
      const r = resolveIdentity(index, name('Taylor Brennan', { evidenceDate }));
      expect(r).toMatchObject({
        personKind: 'quarantined',
        reason: 'ambiguous_name',
        candidateCount: 2,
      });
    }
  });

  it('the gate opens exactly 30 days before startedAt', () => {
    // staff-09 starts 2024-01-10, so 2023-12-11 is the first plausible day.
    const at = (d: string) => resolveIdentity(index, name('Taylor Brennan', { evidenceDate: d }));
    expect(at('2023-12-11')).toMatchObject({ personKind: 'quarantined', reason: 'ambiguous_name' });
    expect(at('2023-12-10')).toMatchObject({ personKind: 'staff', staffId: 'staff-08' });
  });

  it('a single candidate that fails the window is quarantined, not external', () => {
    const r = resolveIdentity(index, name('Marta Eklund', { evidenceDate: '2019-01-01' }));
    expect(r).toMatchObject({
      personKind: 'quarantined',
      reason: 'window_gate',
      candidateCount: 1,
    });
  });

  it('there is no end-side gate: a former employee still resolves to their own row', () => {
    const r = resolveIdentity(index, name('Jordan Wexford', { evidenceDate: '2026-01-01' }));
    expect(r).toMatchObject({ personKind: 'staff', staffId: 'staff-10', staffIsActive: false });
  });

  it('a failed exact match is never replaced by a weaker lookalike', () => {
    // "Sam Ashworth" is exact for staff-16 (starts 2024) and a nickname of staff-15 (2015).
    const early = resolveIdentity(index, name('Sam Ashworth', { evidenceDate: '2020-01-01' }));
    expect(early).toMatchObject({
      personKind: 'quarantined',
      reason: 'window_gate',
      method: 'name_exact',
    });
    expect(
      resolveIdentity(index, name('Sam Ashworth', { evidenceDate: '2025-01-01' })),
    ).toMatchObject({
      staffId: 'staff-16',
    });
  });

  it('reports which gates ran', () => {
    const dated = resolveIdentity(
      index,
      name('Zofia Marek-Lindqvist', { evidenceDate: '2023-01-01' }),
    );
    expect(dated).toMatchObject({ gates: { window: 'passed', account: 'not_evaluated' } });
    const undated = resolveIdentity(index, name('Zofia Marek-Lindqvist'));
    expect(undated).toMatchObject({ gates: { window: 'not_evaluated', account: 'not_evaluated' } });
  });
});

describe('account plausibility gate', () => {
  it('removes a candidate with no link to the account', () => {
    const r = resolveIdentity(index, name('Taylor Brennan', { evidenceDate: '2025-06-01' }), {
      account: { linkedStaffIds: new Set(['staff-09']) },
    });
    expect(r).toMatchObject({
      staffId: 'staff-09',
      excludedByGate: 1,
      gates: { account: 'passed' },
    });
  });

  it('quarantines when no candidate is linked', () => {
    const r = resolveIdentity(index, name('Marta Eklund'), {
      account: { linkedStaffIds: new Set(['staff-01']) },
    });
    expect(r).toMatchObject({ personKind: 'quarantined', reason: 'account_gate' });
  });

  it('is not evaluated without a linked set', () => {
    expect(resolveIdentity(index, name('Marta Eklund'), { account: {} })).toMatchObject({
      personKind: 'staff',
      gates: { account: 'not_evaluated' },
    });
  });
});

describe('external, client-side and unusable', () => {
  it('a client-side person is never matched, even with a staff name and email', () => {
    const r = resolveIdentity(index, {
      rawName: 'Zofia Marek-Lindqvist',
      rawEmail: 'zofia.marek-lindqvist@agency.example',
      isClientSide: true,
    });
    expect(r).toEqual({
      personKind: 'external_unresolved',
      staffId: null,
      withheldReason: 'unresolved',
      reason: 'client_side',
    });
  });

  it('a name not in the roster is external', () => {
    expect(resolveIdentity(index, name('Quentin Farragut'))).toMatchObject({
      personKind: 'external_unresolved',
      reason: 'not_in_roster',
    });
  });

  it('a service account row is never matched', () => {
    expect(resolveIdentity(index, name('Brand Team Mailbox'))).toMatchObject({
      reason: 'not_in_roster',
    });
  });

  it('a staff name that is also a known external is quarantined', () => {
    const withExternals = buildRosterIndex(ROSTER, { knownExternals: EXTERNALS });
    expect(resolveIdentity(withExternals, name('Marta Eklund'))).toMatchObject({
      personKind: 'quarantined',
      reason: 'staff_external_collision',
    });
  });

  it('a known external with no staff match is external', () => {
    const withExternals = buildRosterIndex(ROSTER, { knownExternals: EXTERNALS });
    expect(resolveIdentity(withExternals, name('Pavel Orlovsky'))).toMatchObject({
      personKind: 'external_unresolved',
      reason: 'known_external',
    });
  });

  it('empty or symbol-only names are unusable', () => {
    for (const raw of ['', '   ', '???', '---', '"" ()']) {
      expect(resolveIdentity(index, name(raw))).toMatchObject({ reason: 'unusable_name' });
    }
  });

  it('an empty roster resolves nothing', () => {
    expect(resolveIdentity(buildRosterIndex([]), name('Zofia Marek-Lindqvist'))).toMatchObject({
      reason: 'not_in_roster',
    });
  });
});

describe('contract', () => {
  const MENTIONS: Mention[] = [
    ...ROSTER.map((r) => name(r.fullName)),
    name('Sasha Voronin'),
    name('Taylor'),
    name('Zofia Marek-Lindqvst'),
    name('Юрий Коваленко'),
    name('Quentin Farragut'),
    name(''),
    name('Marta Eklund', { evidenceDate: '2019-01-01' }),
    { rawName: 'Taylor Brennan', rawEmail: 'x@agency.example' },
  ];

  it('staff_id is set exactly when personKind is staff, and withheldReason follows the schema rule', () => {
    for (const m of MENTIONS) {
      const r = resolveIdentity(index, m);
      expect(r.staffId !== null).toBe(r.personKind === 'staff');
      expect(r.withheldReason === null).toBe(r.personKind === 'staff');
      if (r.personKind === 'quarantined') expect(r.withheldReason).toBe('ambiguous');
      if (r.personKind === 'external_unresolved') expect(r.withheldReason).toBe('unresolved');
    }
  });

  it('a resolved id always belongs to the roster and never to a service account', () => {
    const ids = new Set(ROSTER.filter((r) => r.isPerson).map((r) => r.staffId));
    for (const m of MENTIONS) {
      const id = staffId(resolveIdentity(index, m));
      if (id !== null) expect(ids.has(id)).toBe(true);
    }
  });

  it('is deterministic and does not mutate its inputs', () => {
    const frozen = ROSTER.map((r) => Object.freeze({ ...r }));
    const idx = buildRosterIndex(Object.freeze(frozen) as RosterEntry[], {
      agencyEmailDomains: DOMAINS,
    });
    const mention = Object.freeze(name('Taylor Brennan', { evidenceDate: '2021-06-01' }));
    const a = resolveIdentity(idx, mention);
    const b = resolveIdentity(idx, mention);
    expect(a).toEqual(b);
  });

  it('a malformed roster start date is a caller bug and throws', () => {
    const bad: RosterEntry = { ...(ROSTER[0] as RosterEntry), startedAt: '01/03/2019' };
    expect(() => buildRosterIndex([bad])).toThrow(RangeError);
  });
});
