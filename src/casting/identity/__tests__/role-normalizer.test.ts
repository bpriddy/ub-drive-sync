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

describe('normalizeRole: mapped titles', () => {
  it.each(MAPPED)('%s -> %s / %s', (raw, role, seniority) => {
    const r = normalizeRole(raw);
    expect(r.roleNorm).toBe(role);
    expect(r.seniority).toBe(seniority);
    expect(r.reason).toBe('mapped');
  });

  it('the examples reach every role_norm value except `other`', () => {
    const reached = new Set(MAPPED.map(([, role]) => role));
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
      roleNorm: 'other',
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
    expect(normalizeRole('Account Supervisor').roleNorm).toBe('other');
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
    for (const [raw] of MAPPED) {
      const r = normalizeRole(raw);
      expect(ROLE_NORMS as readonly string[]).toContain(r.roleNorm);
      if (r.seniority !== null) expect(SENIORITIES as readonly string[]).toContain(r.seniority);
    }
  });
});
