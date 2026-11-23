/**
 * Role normaliser: a raw title string to `role_norm` plus a separate `seniority`.
 * Rule tables only; no model, no guessing. The caller keeps the raw string.
 *
 *  - empty or placeholder text            -> roleNorm null, seniority null (no role stated)
 *  - a title no rule recognises           -> 'other'
 *  - a title naming two different roles   -> 'other' (reason 'multi_role'); never the first one
 *  - seniority comes from explicit markers in the same title and is independent
 *    of the function: "Senior Zookeeper" is ('other', 'senior'); "Copywriter" is
 *    ('copywriter', null). Several markers: the highest wins.
 *
 * The marker table follows the approved vocabulary note, with one ruling on top:
 * "Art Director" does not carry the marker "Director" (see CRAFT_TITLE).
 */
import type { RoleNorm, Seniority } from './vocab';

export interface RoleNormalization {
  readonly roleNorm: RoleNorm | null;
  readonly seniority: Seniority | null;
  readonly reason: 'no_role' | 'mapped' | 'unmapped' | 'multi_role';
}

const PLACEHOLDERS = new Set(['n/a', 'na', 'none', 'tbd', 'tbc', 'unknown', 'null', '-', '--']);

const ABBREVIATIONS: readonly (readonly [RegExp, string])[] = [
  [/\bsr\b/g, 'senior'],
  [/\bsnr\b/g, 'senior'],
  [/\bjr\b/g, 'junior'],
  [/\bjnr\b/g, 'junior'],
  [/\bmgr\b/g, 'manager'],
  [/\bdir\b/g, 'director'],
  [/\basst\b/g, 'assistant'],
  [/\bassoc\b/g, 'associate'],
  [/\bexec\b/g, 'executive'],
  [/\bcomms\b/g, 'communications'],
  [/\bbus\b/g, 'business'],
  // Common misspellings of words the rules below depend on.
  [/\b(buiness|buisness|bussiness|busines|businness)\b/g, 'business'],
  [/\b(affiars|affars|afairs|affaris)\b/g, 'affairs'],
];

/** Lower-case, diacritics stripped, dots dropped, hyphens and brackets to spaces. */
function prepare(raw: string): string {
  let t = raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[()[\]]/g, ' ')
    .replace(/[-–—]/g, ' ');
  for (const [re, to] of ABBREVIATIONS) t = t.replace(re, to);
  return t.replace(/[ \t]+/g, ' ').trim();
}

/**
 * Role rules in priority order: the first rule that matches a segment wins for
 * that segment. Specific titles come before the generic words they contain
 * ("social media manager" before "media manager", "media planner" before "planner").
 */
const ROLE_RULES: readonly (readonly [RoleNorm, RegExp])[] = [
  [
    'executive_creative_director',
    /\b(executive creative director|chief creative officer|chief creative|ecd|cco|gcco)\b/,
  ],
  [
    'associate_creative_director',
    /\b(associate creative director|assistant creative director|acd)\b/,
  ],
  ['creative_director', /\b(creative director|cd)\b/],
  ['design_director', /\b(design director|design lead|head of design|director of design)\b/],
  ['art_director', /\b(art director|art lead)\b/],
  [
    'social_media_specialist',
    /\b(social|community (manager|lead|specialist|director)|content (lead|manager|strategist|creator|specialist))\b/,
  ],
  // Before the PR rule: "head of comms strategy" is a strategy title, not a PR one.
  [
    'strategy_director',
    /\b((head|director) of communications strategy|communications strategy director)\b/,
  ],
  ['strategist', /\bcommunications (strategy|strategist)\b/],
  [
    'pr_specialist',
    /\b(pr|publicist|public relations|communications (lead|manager|director|specialist)|head of (pr|communications))\b/,
  ],
  [
    'media_planner',
    /\b(media (planner|planning|buyer|buying|director|manager|supervisor|lead|executive|strategist|specialist)|head of media)\b/,
  ],
  [
    'strategy_director',
    /\b(strategy director|head of strategy|director of strategy|chief strategy officer|planning director|head of planning)\b/,
  ],
  ['strategist', /\b(strategist|planner)\b/],
  [
    'account_director',
    /\b(account director|account lead|client lead|client service director|client services director|business director|head of (account|client))\b/,
  ],
  [
    'account_executive',
    /\b(account executive|account coordinator|account assistant|account intern|ae)\b/,
  ],
  ['account_manager', /\b(account manager|account supervisor|account contact|client manager|am)\b/],
  [
    'executive_producer',
    /\b(executive producer|head of production|production director|director of production|ep)\b/,
  ],
  ['production_manager', /\b(production manager|traffic manager|traffic)\b/],
  // A bare "Production" is the producer's function; it is anchored so that
  // "Music Production" or "Production Designer" never reach it.
  ['producer', /\bproducer\b|^((senior|junior|lead|associate|assistant) )*production$/],
  [
    'project_manager',
    /\b(project manager|project lead|project director|program director|programme director|pm)\b/,
  ],
  ['technologist', /\b(technologist|developer)\b/],
  ['finance', /\b(finance|financial|business manager|controller)\b/],
  ['data_analyst', /\b(analyst|insights?|data scientist)\b/],
  [
    'copywriter',
    /\b(copywriter|copy writer|writer)\b|^((senior|junior|lead|associate|assistant) )*copy$/,
  ],
  ['designer', /\bdesigner\b/],
];

function matchSegment(segment: string): RoleNorm | null {
  for (const [role, re] of ROLE_RULES) if (re.test(segment)) return role;
  return null;
}

/** Splits only on explicit multi-role separators. A comma is not one ("Account Director, Brand X"). */
function segmentsOf(prepared: string): string[] {
  return prepared
    .split(/\/|&|\+|,|\band\b/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const MARKERS: readonly (readonly [Seniority, RegExp])[] = [
  [
    'executive',
    /\b(vp|svp|evp|vice president|president|chief|ceo|cco|gcco|managing director|partner|executive creative director|executive director|ecd)\b/,
  ],
  ['director', /\b(director|head of|cd|acd)\b/],
  ['lead', /\b(lead|principal|group)\b/],
  ['senior', /\bsenior\b/],
  // "Associate" is a junior marker except in "Associate Creative Director" (a director-level title).
  ['junior', /\b(junior|assistant|coordinator|intern|associate(?! creative director))\b/],
];

/**
 * "Art Director" is a craft title, not a leadership one: the word Director in it
 * is not a marker (ruling 2026-11-19). Other markers in the same title still count
 * ("Sr. Art Director" is senior, "Associate Art Director" is junior, "Group Art
 * Director" is lead). Design Director, Creative Director and the rest keep Director.
 */
const CRAFT_TITLE = /\bart director\b/g;

function seniorityOf(prepared: string): Seniority | null {
  const text = prepared.replace(CRAFT_TITLE, ' ');
  for (const [level, re] of MARKERS) if (re.test(text)) return level;
  return null;
}

export function normalizeRole(raw: string | null | undefined): RoleNormalization {
  const prepared = raw ? prepare(raw) : '';
  if (prepared === '' || PLACEHOLDERS.has(prepared) || !/\p{L}/u.test(prepared)) {
    return { roleNorm: null, seniority: null, reason: 'no_role' };
  }

  const seniority = seniorityOf(prepared);
  const roles = new Set<RoleNorm>();
  for (const segment of segmentsOf(prepared)) {
    const role = matchSegment(segment);
    if (role !== null) roles.add(role);
  }

  if (roles.size === 0) return { roleNorm: 'other', seniority, reason: 'unmapped' };
  if (roles.size > 1) return { roleNorm: 'other', seniority, reason: 'multi_role' };
  return { roleNorm: [...roles][0] as RoleNorm, seniority, reason: 'mapped' };
}
