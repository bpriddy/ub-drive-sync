import { describe, expect, it } from 'vitest';
import { normalizeRole } from '../role-normalizer';
import { ROLE_NORMS, SENIORITIES, type RoleNorm, type Seniority } from '../vocab';

type Row = [raw: string, role: RoleNorm, seniority: Seniority | null];

// Titles from the approved vocabulary note, with the seniority its marker table implies.
const MAPPED: Row[] = [
  ['ECD', 'executive_creative_director', 'executive'],
  ['Executive Creative Director', 'executive_creative_director', 'executive'],
  ['Chief Creative Officer', 'executive_creative_director', 'executive'],
  ['CD', 'creative_director', 'director'],
  ['Group Creative Director', 'creative_director', 'director'],
  ['ACD', 'associate_creative_director', 'director'],
  ['Associate Creative Director', 'associate_creative_director', 'director'],
  ['Art Dir.', 'art_director', null],
  ['Art Director', 'art_director', null],
  ['Sr. Art Director', 'art_director', 'senior'],
  ['Associate Art Director', 'art_director', 'junior'],
  ['Group Art Director', 'art_director', 'lead'],
  ['Copy', 'copywriter', null],
  ['Copywriter', 'copywriter', null],
  ['Sr. Copywriter', 'copywriter', 'senior'],
  ['Writer', 'copywriter', null],
  ['Designer', 'designer', null],
  ['Sr. Designer', 'designer', 'senior'],
  ['Motion Designer', 'designer', null],
  ['Design Lead', 'design_director', 'lead'],
  ['Head of Design', 'design_director', 'director'],
  ['Head of Strategy', 'strategy_director', 'director'],
  ['Group Strategy Director', 'strategy_director', 'director'],
  ['Planner', 'strategist', null],
  ['Brand Strategist', 'strategist', null],
  ['Group Account Director', 'account_director', 'director'],
  ['Client Lead', 'account_director', 'lead'],
  ['AM', 'account_manager', null],
  ['Sr. Account Manager', 'account_manager', 'senior'],
  ['AE', 'account_executive', null],
  ['Account Exec', 'account_executive', null],
  ['Account Coordinator', 'account_executive', 'junior'],
  ['EP', 'executive_producer', null],
  ['Executive Producer', 'executive_producer', null],
  ['Head of Production', 'executive_producer', 'director'],
  ['Producer', 'producer', null],
  ['Sr. Producer', 'producer', 'senior'],
  ['Associate Producer', 'producer', 'junior'],
  ['Production Mgr', 'production_manager', null],
  ['Traffic', 'production_manager', null],
  ['PM', 'project_manager', null],
  ['Project Lead', 'project_manager', 'lead'],
  ['Developer', 'technologist', null],
  ['Creative Technologist', 'technologist', null],
  ['Analyst', 'data_analyst', null],
  ['Insights', 'data_analyst', null],
  ['Media Planner', 'media_planner', null],
  ['Media Buyer', 'media_planner', null],
  ['Media Director', 'media_planner', 'director'],
  ['Head of Media', 'media_planner', 'director'],
  ['Social Media Manager', 'social_media_specialist', null],
  ['Community Manager', 'social_media_specialist', null],
  ['Social Strategist', 'social_media_specialist', null],
  ['Content Lead', 'social_media_specialist', 'lead'],
  ['PR Manager', 'pr_specialist', null],
  ['Publicist', 'pr_specialist', null],
  ['Communications Lead', 'pr_specialist', 'lead'],
  ['Head of PR', 'pr_specialist', 'director'],
  ['Finance Manager', 'finance', null],
  ['Business Manager', 'finance', null],
];

// Rules added after a real run left half the staff mentions in `other`. Generic titles only.
const EXTENDED: Row[] = [
  // Account side: a lead is a director-level seat (as "Client Lead"), a supervisor is a manager.
  ['Account Supervisor', 'account_manager', null],
  ['Senior Account Supervisor', 'account_manager', 'senior'],
  ['Account Lead', 'account_director', 'lead'],
  ['Account Contact', 'account_manager', null],
  ['Account Intern', 'account_executive', 'junior'],
  ['Business Director', 'account_director', 'director'],
  ['Group Business Director', 'account_director', 'director'],
  // Production side.
  ['Production', 'producer', null],
  ['Senior Production', 'producer', 'senior'],
  ['Production Director', 'executive_producer', 'director'],
  ['Group Production Director', 'executive_producer', 'director'],
  ['Director of Production', 'executive_producer', 'director'],
  // Project side: Director is a marker here, unlike in Art Director.
  ['Project Director', 'project_manager', 'director'],
  ['Project Dir.', 'project_manager', 'director'],
  ['Program Director', 'project_manager', 'director'],
  ['Programme Director', 'project_manager', 'director'],
  // Communications strategy is a strategy title; plain communications stays PR.
  ['Head of Comms Strategy', 'strategy_director', 'director'],
  ['Head of Communications Strategy', 'strategy_director', 'director'],
  ['Director of Communications Strategy', 'strategy_director', 'director'],
  ['Communications Strategy Director', 'strategy_director', 'director'],
  ['Comms Strategy', 'strategist', null],
  ['Communications Strategist', 'strategist', null],
  ['Head of Comms', 'pr_specialist', 'director'],
  ['Group Comms Director', 'pr_specialist', 'director'],
  // Chief creative officer, with or without the Global prefix.
  ['CCO', 'executive_creative_director', 'executive'],
  ['Global CCO', 'executive_creative_director', 'executive'],
  ['GCCO', 'executive_creative_director', 'executive'],
  ['Chief Creative Officer & Partner', 'executive_creative_director', 'executive'],
  ['Partner & Global CCO', 'executive_creative_director', 'executive'],
  // Misspellings of the words the rules depend on.
  ['Buisness Director', 'account_director', 'director'],
  ['Buiness Director', 'account_director', 'director'],
  ['Bus. Director', 'account_director', 'director'],
  // Business affairs, including the misspellings and abbreviations the normaliser repairs.
  ['Business Affairs', 'business_affairs', null],
  ['Business Affairs Manager', 'business_affairs', null],
  ['Sr. Business Affairs Manager', 'business_affairs', 'senior'],
  ['Senior Business Affairs Manager', 'business_affairs', 'senior'],
  ['Head of Business Affairs', 'business_affairs', 'director'],
  ['Head of BA', 'business_affairs', 'director'],
  ['Director of Business Affairs', 'business_affairs', 'director'],
  ['Talent Manager Business Affairs', 'business_affairs', null],
  ['Buiness Affiars Manager', 'business_affairs', null],
  ['Bussiness Afairs', 'business_affairs', null],
  ['Agency Bus. Affairs', 'business_affairs', null],
  // Executive leadership: always seniority executive, whatever the title carries.
  ['CEO', 'executive_leadership', 'executive'],
  ['CEO, Springfield', 'executive_leadership', 'executive'],
  ['Chief Executive Officer', 'executive_leadership', 'executive'],
  ['Managing Partner', 'executive_leadership', 'executive'],
  ['Founding Partner', 'executive_leadership', 'executive'],
  ['Partner', 'executive_leadership', 'executive'],
  ['Managing Director', 'executive_leadership', 'executive'],
  ['Owner', 'executive_leadership', 'executive'],
  ['President', 'executive_leadership', 'executive'],
  // Operations.
  ['Business Operations Director', 'operations', 'director'],
  ['Business Operations Manager', 'operations', null],
  ['Sr. Business Operations Manager', 'operations', 'senior'],
  ['Head of Operations', 'operations', 'director'],
  ['Operations Lead', 'operations', 'lead'],
  // The functional segment wins over a leadership seat, in one segment or across commas.
  ['Managing Partner Operations Lead', 'operations', 'executive'],
  ['Managing Partner, Springfield, Account Lead', 'account_director', 'executive'],
  ['Managing Director & Producer', 'producer', 'executive'],
  // Music and audio.
  ['Music', 'music_audio', null],
  ['Music Production', 'music_audio', null],
  ['Senior Music Production', 'music_audio', 'senior'],
  ['Music Director', 'music_audio', 'director'],
  ['Director of Music', 'music_audio', 'director'],
  ['Director of Music Production', 'music_audio', 'director'],
  ['Music Production Director', 'music_audio', 'director'],
];

describe('normalizeRole: extended titles', () => {
  it.each(EXTENDED)('%s -> %s / %s', (raw, role, seniority) => {
    expect(normalizeRole(raw)).toEqual({ roleNorm: role, seniority, reason: 'mapped' });
  });

  it('CCO is an executive marker and still an executive creative director', () => {
    expect(normalizeRole('CCO')).toMatchObject({
      roleNorm: 'executive_creative_director',
      seniority: 'executive',
    });
    expect(normalizeRole('Chief Creative Officer, Partner')).toMatchObject({
      roleNorm: 'executive_creative_director',
      seniority: 'executive',
    });
  });

  it('titles with no approved vocabulary value stay `other`', () => {
    for (const raw of [
      'Talent Manager',
      'Business Lead',
      'Creative',
      'Account',
      'Operations',
      'Client Partner',
      'Product Owner',
      'Vice President',
      'Senior Vice President, Strategy',
    ]) {
      expect(normalizeRole(raw)).toMatchObject({ roleNorm: 'other', reason: 'unmapped' });
    }
  });

  it('a leadership seat never beats a CCO in the same title', () => {
    for (const raw of [
      'Partner & Global CCO',
      'Managing Partner & Chief Creative Officer',
      'CCO, CEO',
    ]) {
      expect(normalizeRole(raw)).toMatchObject({
        roleNorm: 'executive_creative_director',
        seniority: 'executive',
        reason: 'mapped',
      });
    }
  });

  it('Finance stays finance and Business Manager is not business affairs', () => {
    expect(normalizeRole('Finance').roleNorm).toBe('finance');
    expect(normalizeRole('Business Manager').roleNorm).toBe('finance');
    expect(normalizeRole('Business Affairs & Finance Manager')).toMatchObject({
      roleNorm: 'other',
      reason: 'multi_role',
    });
  });

  it('a bare Account is too vague to place and stays `other`', () => {
    expect(normalizeRole('Account')).toMatchObject({ roleNorm: 'other', reason: 'unmapped' });
  });

  it('Production in a longer title does not become a producer', () => {
    expect(normalizeRole('Production Designer').roleNorm).toBe('designer');
    expect(normalizeRole('Production Designer').roleNorm).not.toBe('music_audio');
    expect(normalizeRole('Music Production').roleNorm).not.toBe('producer');
    expect(normalizeRole('Production')).toMatchObject({ roleNorm: 'producer' });
    expect(normalizeRole('Music Production').roleNorm).toBe('music_audio');
    expect(normalizeRole('Music Production Director').roleNorm).toBe('music_audio');
    expect(normalizeRole('Production Company Liaison').roleNorm).toBe('other');
  });

  it('a business title that is not Business Director is not an account title', () => {
    expect(normalizeRole('Business Lead').roleNorm).toBe('other');
    expect(normalizeRole('Business Operations Manager').roleNorm).toBe('operations');
  });

  it('a title naming a mapped and an unmapped role keeps the mapped one', () => {
    expect(normalizeRole('Managing Partner & Global CCO')).toMatchObject({
      roleNorm: 'executive_creative_director',
      seniority: 'executive',
      reason: 'mapped',
    });
  });

  it('two mapped roles still conflict: Art Director / Copywriter stays `other`', () => {
    expect(normalizeRole('Art Director / Copywriter')).toMatchObject({
      roleNorm: 'other',
      reason: 'multi_role',
    });
    expect(normalizeRole('Account Supervisor & Producer')).toMatchObject({
      roleNorm: 'other',
      reason: 'multi_role',
    });
  });
});

describe('normalizeRole: mapped titles', () => {
  it.each(MAPPED)('%s -> %s / %s', (raw, role, seniority) => {
    const r = normalizeRole(raw);
    expect(r.roleNorm).toBe(role);
    expect(r.seniority).toBe(seniority);
    expect(r.reason).toBe('mapped');
  });

  it('the examples reach every role_norm value except `other`', () => {
    const reached = new Set([...MAPPED, ...EXTENDED].map(([, role]) => role));
    for (const role of ROLE_NORMS) if (role !== 'other') expect(reached.has(role)).toBe(true);
  });

  it('the examples reach every seniority value', () => {
    const reached = new Set(MAPPED.map(([, , s]) => s));
    for (const s of SENIORITIES) expect(reached.has(s)).toBe(true);
  });

  it('ignores case, dots, hyphens, diacritics and surrounding noise', () => {
    expect(normalizeRole('  SR. COPYWRITER ')).toMatchObject({
      roleNorm: 'copywriter',
      seniority: 'senior',
    });
    expect(normalizeRole('Sénior Copywriter')).toMatchObject({
      roleNorm: 'copywriter',
    });
    expect(normalizeRole('Art-Director')).toMatchObject({ roleNorm: 'art_director' });
  });

  it('a trailing client or brand after a comma does not change the role', () => {
    expect(normalizeRole('Account Director, Brand X')).toMatchObject({
      roleNorm: 'account_director',
      seniority: 'director',
    });
  });
});

describe('normalizeRole: seniority markers', () => {
  it('the highest marker in one title wins', () => {
    expect(normalizeRole('Senior Vice President, Strategy').seniority).toBe('executive');
    expect(normalizeRole('Senior Director of Design').seniority).toBe('director');
    expect(normalizeRole('Lead Senior Copywriter').seniority).toBe('lead');
  });

  it('Associate is junior except in Associate Creative Director', () => {
    expect(normalizeRole('Associate Designer').seniority).toBe('junior');
    expect(normalizeRole('Assistant Account Executive').seniority).toBe('junior');
    expect(normalizeRole('Associate Creative Director').seniority).toBe('director');
  });

  it('Managing Director and Partner are executive', () => {
    expect(normalizeRole('Managing Director')).toMatchObject({
      roleNorm: 'executive_leadership',
      seniority: 'executive',
    });
    expect(normalizeRole('Partner, Strategy').seniority).toBe('executive');
  });

  it('Art Director is a craft title: Director in it is not a marker', () => {
    expect(normalizeRole('Art Director').seniority).toBeNull();
    expect(normalizeRole('Art Dir.').seniority).toBeNull();
    // Other titles keep the marker.
    expect(normalizeRole('Design Director').seniority).toBe('director');
    expect(normalizeRole('Creative Director').seniority).toBe('director');
    expect(normalizeRole('Associate Creative Director').seniority).toBe('director');
    expect(normalizeRole('Art Director, Creative Director')).toMatchObject({ roleNorm: 'other' });
  });

  it('Executive Producer carries no marker; Executive is a marker only in ECD and Executive Director', () => {
    expect(normalizeRole('Executive Producer').seniority).toBeNull();
    expect(normalizeRole('Executive Director').seniority).toBe('executive');
    expect(normalizeRole('Executive Creative Director').seniority).toBe('executive');
  });

  it('a bare function carries no marker: Copywriter is not mid-level', () => {
    expect(normalizeRole('Copywriter').seniority).toBeNull();
  });
});

describe('normalizeRole: unknown, multiple and empty', () => {
  it('an unknown title is `other`, with a marker only when one is written', () => {
    expect(normalizeRole('Zookeeper')).toEqual({
      roleNorm: 'other',
      seniority: null,
      reason: 'unmapped',
    });
    expect(normalizeRole('Senior Zookeeper')).toEqual({
      roleNorm: 'other',
      seniority: 'senior',
      reason: 'unmapped',
    });
    expect(normalizeRole('Account Wrangler').roleNorm).toBe('other');
  });

  it('two different roles in one title is `other`, never the first one', () => {
    for (const raw of [
      'Art Director / Copywriter',
      'Copywriter and Art Director',
      'Producer + PM',
    ]) {
      expect(normalizeRole(raw)).toMatchObject({ roleNorm: 'other', reason: 'multi_role' });
    }
  });

  it('the same role written twice is not a conflict', () => {
    expect(normalizeRole('Copywriter / Writer')).toMatchObject({
      roleNorm: 'copywriter',
      reason: 'mapped',
    });
  });

  it('empty, placeholder and missing text states no role', () => {
    for (const raw of [undefined, null, '', '   ', 'n/a', 'TBD', '-', '??']) {
      expect(normalizeRole(raw as string | null | undefined)).toEqual({
        roleNorm: null,
        seniority: null,
        reason: 'no_role',
      });
    }
  });

  it('a title in another script is stated but unmapped, not "no role"', () => {
    expect(normalizeRole('Арт-директор')).toMatchObject({ roleNorm: 'other', reason: 'unmapped' });
  });

  it('every output value is in the closed sets', () => {
    for (const [raw] of [...MAPPED, ...EXTENDED]) {
      const r = normalizeRole(raw);
      expect(ROLE_NORMS as readonly string[]).toContain(r.roleNorm);
      if (r.seniority !== null) expect(SENIORITIES as readonly string[]).toContain(r.seniority);
    }
  });
});
