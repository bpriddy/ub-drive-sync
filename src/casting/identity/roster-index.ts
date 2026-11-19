import { CASTING_EMPLOYMENT_START_TOLERANCE_DAYS } from './vocab';
import {
  type NameForms,
  exactKeysOf,
  firstLastKey,
  looseFoldToken,
  normalizeEmail,
  normalizeName,
} from './name-normalize';
import type { KnownExternal, RosterEntry, RosterIndexOptions } from './types';

type Multi = Map<string, Set<number>>;

export interface IndexedStaff {
  readonly entry: RosterEntry;
  readonly forms: NameForms;
  /** Days since epoch of startedAt. */
  readonly startDay: number;
  readonly fullKeys: readonly string[];
}

export interface RosterIndex {
  readonly staff: readonly IndexedStaff[];
  readonly byEmail: Multi;
  readonly exact: Multi;
  readonly alias: Multi;
  readonly firstLast: Multi;
  readonly looseFull: Multi;
  readonly looseFirstLast: Multi;
  readonly byToken: Multi;
  readonly byLastToken: Multi;
  readonly agencyDomains: ReadonlySet<string>;
  readonly externalNameKeys: ReadonlySet<string>;
  readonly externalEmails: ReadonlySet<string>;
  readonly startToleranceDays: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since epoch for an ISO date, or null when malformed. */
export function isoDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = ISO_DATE.exec(value.slice(0, 10));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : Math.floor(ms / 86_400_000);
}

function add(map: Multi, key: string | null, idx: number): void {
  if (!key) return;
  const set = map.get(key);
  if (set) set.add(idx);
  else map.set(key, new Set([idx]));
}

/** Order-sensitive and order-insensitive keys for a set of token lists. */
function nameKeys(forms: NameForms): string[] {
  const lists = [forms.tokens, ...(forms.germanTokens ? [forms.germanTokens] : [])];
  return lists.flatMap((t) => exactKeysOf(t));
}

function externalKeys(ext: KnownExternal): string[] {
  const forms = normalizeName(ext.fullName);
  return nameKeys(forms);
}

/**
 * Builds the lookup structure once per roster snapshot. Throws on a malformed
 * startedAt: that is a caller bug, not data to guess around.
 */
export function buildRosterIndex(
  entries: readonly RosterEntry[],
  options: RosterIndexOptions = {},
): RosterIndex {
  const staff: IndexedStaff[] = [];
  const byEmail: Multi = new Map();
  const exact: Multi = new Map();
  const alias: Multi = new Map();
  const firstLast: Multi = new Map();
  const looseFull: Multi = new Map();
  const looseFirstLast: Multi = new Map();
  const byToken: Multi = new Map();
  const byLastToken: Multi = new Map();

  for (const entry of entries) {
    if (!entry.isPerson) continue;
    const startDay = isoDay(entry.startedAt);
    if (startDay === null) {
      throw new RangeError(`roster entry ${entry.staffId}: startedAt is not YYYY-MM-DD`);
    }
    const forms = normalizeName(entry.fullName);
    const idx = staff.length;
    staff.push({ entry, forms, startDay, fullKeys: nameKeys(forms) });

    const email = entry.email ? normalizeEmail(entry.email) : null;
    add(byEmail, email, idx);

    for (const k of nameKeys(forms)) add(exact, k, idx);
    for (const a of entry.aliases ?? []) {
      for (const k of nameKeys(normalizeName(a))) add(alias, k, idx);
    }

    const lists = [forms.tokens, ...(forms.germanTokens ? [forms.germanTokens] : [])];
    for (const t of lists) {
      add(firstLast, firstLastKey(t), idx);
      for (const tok of t) add(byToken, tok, idx);
      if (t.length >= 2) {
        add(byLastToken, t[t.length - 1] as string, idx);
        add(byLastToken, looseFoldToken(t[t.length - 1] as string), idx);
      }
    }
    for (const k of exactKeysOf(forms.looseTokens)) add(looseFull, k, idx);
    add(looseFirstLast, firstLastKey(forms.looseTokens), idx);
  }

  const externalNameKeys = new Set<string>();
  const externalEmails = new Set<string>();
  for (const ext of options.knownExternals ?? []) {
    for (const k of externalKeys(ext)) externalNameKeys.add(k);
    const e = ext.email ? normalizeEmail(ext.email) : null;
    if (e) externalEmails.add(e);
  }

  return {
    staff,
    byEmail,
    exact,
    alias,
    firstLast,
    looseFull,
    looseFirstLast,
    byToken,
    byLastToken,
    agencyDomains: new Set((options.agencyEmailDomains ?? []).map((d) => d.trim().toLowerCase())),
    externalNameKeys,
    externalEmails,
    startToleranceDays: CASTING_EMPLOYMENT_START_TOLERANCE_DAYS,
  };
}
