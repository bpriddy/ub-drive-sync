import {
  type NameForms,
  boundedEditDistance,
  emailDomain,
  exactKeysOf,
  firstLastKey,
  fullKey,
  looseFoldToken,
  normalizeEmail,
  normalizeName,
} from './name-normalize';
import { nicknameEquivalent } from './nicknames';
import { type IndexedStaff, type RosterIndex, isoDay } from './roster-index';
import {
  type ExternalReason,
  type GateState,
  type IdentityResolution,
  MATCH_METHODS,
  MATCH_STRENGTH,
  type MatchMethod,
  type Mention,
  type QuarantineReason,
  RESOLVABLE_METHODS,
  type ResolutionContext,
} from './types';

/** More candidates than this on a partial name means the name says nothing. */
const MAX_PARTIAL_CANDIDATES = 5;
/** Candidate ids kept on a quarantined row. */
const MAX_REPORTED_CANDIDATES = 10;
const FUZZY_MIN_LENGTH = 8;

const rank = (m: MatchMethod): number => MATCH_METHODS.indexOf(m);

const external = (reason: ExternalReason): IdentityResolution => ({
  personKind: 'external_unresolved',
  staffId: null,
  withheldReason: 'unresolved',
  reason,
});

function quarantined(
  index: RosterIndex,
  reason: QuarantineReason,
  candidates: readonly number[],
  method: MatchMethod | null,
): IdentityResolution {
  return {
    personKind: 'quarantined',
    staffId: null,
    withheldReason: 'ambiguous',
    reason,
    candidateStaffIds: candidates
      .slice(0, MAX_REPORTED_CANDIDATES)
      .map((i) => (index.staff[i] as IndexedStaff).entry.staffId),
    candidateCount: candidates.length,
    method,
  };
}

/** Name variants to try: the written name, plus "<nickname hint> <last>" for quoted nicknames. */
function mentionVariants(forms: NameForms): NameForms[] {
  const variants = [forms];
  if (forms.tokens.length >= 2) {
    const last = forms.tokens[forms.tokens.length - 1] as string;
    for (const hint of new Set(forms.hints)) {
      const tokens = [hint, last];
      variants.push({
        tokens,
        germanTokens: null,
        looseTokens: tokens.map(looseFoldToken),
        hints: [],
      });
    }
  }
  return variants;
}

type CandidateMap = Map<number, MatchMethod>;

function note(cands: CandidateMap, idx: number, method: MatchMethod): void {
  const have = cands.get(idx);
  if (have === undefined || rank(method) < rank(have)) cands.set(idx, method);
}

function noteAll(cands: CandidateMap, set: ReadonlySet<number> | undefined, m: MatchMethod): void {
  if (set) for (const idx of set) note(cands, idx, m);
}

function tokenLists(forms: NameForms): (readonly string[])[] {
  return [forms.tokens, ...(forms.germanTokens ? [forms.germanTokens] : [])];
}

/** Candidates from the deterministic tiers (everything above fuzzy). */
function collectDeterministic(index: RosterIndex, variants: NameForms[]): CandidateMap {
  const cands: CandidateMap = new Map();
  for (const forms of variants) {
    const lists = tokenLists(forms);
    for (const t of lists) {
      if (t.length === 0) continue;
      for (const k of exactKeysOf(t)) {
        noteAll(cands, index.exact.get(k), 'name_exact');
        noteAll(cands, index.alias.get(k), 'alias');
      }
      const fl = firstLastKey(t);
      if (fl) noteAll(cands, index.firstLast.get(fl), 'name_first_last');
    }
    if (forms.looseTokens.length > 0) {
      for (const k of exactKeysOf(forms.looseTokens)) {
        noteAll(cands, index.looseFull.get(k), 'translit');
      }
      const fl = firstLastKey(forms.looseTokens);
      if (fl) noteAll(cands, index.looseFirstLast.get(fl), 'translit');
    }

    // Nickname and initial: the last name must agree, the first name is the variable part.
    for (const t of lists) {
      if (t.length < 2) continue;
      const first = t[0] as string;
      const last = t[t.length - 1] as string;
      const sameLast = new Set<number>();
      for (const key of [last, looseFoldToken(last)]) {
        for (const idx of index.byLastToken.get(key) ?? []) sameLast.add(idx);
      }
      for (const idx of sameLast) {
        const s = index.staff[idx] as IndexedStaff;
        for (const st of tokenLists(s.forms)) {
          if (st.length < 2) continue;
          const sFirst = st[0] as string;
          if (first.length === 1) {
            if (sFirst.startsWith(first)) note(cands, idx, 'initial');
          } else if (nicknameEquivalent(first, sFirst)) {
            note(cands, idx, 'nickname');
          }
        }
      }
    }
  }
  return cands;
}

/** Candidate-only tiers: near-miss spellings, then partial names. */
function collectWeak(index: RosterIndex, variants: NameForms[]): CandidateMap {
  const cands: CandidateMap = new Map();
  for (const forms of variants) {
    for (const t of tokenLists(forms)) {
      const key = fullKey(t);
      if (t.length >= 2 && key.length >= FUZZY_MIN_LENGTH) {
        index.staff.forEach((s, idx) => {
          for (const k of s.fullKeys) {
            if (k.length >= FUZZY_MIN_LENGTH && boundedEditDistance(key, k, 1) <= 1) {
              note(cands, idx, 'fuzzy');
              break;
            }
          }
        });
      }
    }
  }
  if (cands.size > 0) return cands;

  // Partial: every mention token is a token of the staff name, and the staff name has more.
  for (const forms of variants) {
    for (const t of tokenLists(forms)) {
      if (t.length === 0) continue;
      const sets = t.map((tok): ReadonlySet<number> => index.byToken.get(tok) ?? new Set<number>());
      const [firstSet, ...restSets] = sets as [ReadonlySet<number>, ...ReadonlySet<number>[]];
      const acc = [...firstSet].filter((i) => restSets.every((set) => set.has(i)));
      for (const idx of acc) {
        const s = index.staff[idx] as IndexedStaff;
        if (s.forms.tokens.length > t.length) note(cands, idx, 'partial');
      }
    }
  }
  return cands;
}

/** An email hit and a written name must not contradict each other. */
function nameCompatible(forms: NameForms, staff: IndexedStaff): boolean {
  if (forms.tokens.length === 0) return true;
  const staffTokens = new Set(tokenLists(staff.forms).flat());
  const staffLoose = new Set(staff.forms.looseTokens);
  const sFirst = staff.forms.tokens[0] as string;
  const all = [...tokenLists(forms).flat(), ...forms.hints];
  return all.some(
    (tok) =>
      staffTokens.has(tok) ||
      staffLoose.has(looseFoldToken(tok)) ||
      nicknameEquivalent(tok, sFirst) ||
      (tok.length === 1 && sFirst.startsWith(tok)),
  );
}

interface GateOutcome {
  readonly passing: number[];
  readonly failedWindow: number[];
  readonly failedAccount: number[];
  readonly window: GateState;
  readonly account: GateState;
}

/**
 * Window: the evidence date must not be earlier than startedAt minus the tolerance.
 * No end-side gate. Account: when the caller supplies linked staff, a candidate
 * outside the set fails. A gate with no input is not evaluated, never failed.
 */
function applyGates(
  index: RosterIndex,
  candidates: readonly number[],
  evidenceDay: number | null,
  linked: ReadonlySet<string> | undefined,
): GateOutcome {
  const passing: number[] = [];
  const failedWindow: number[] = [];
  const failedAccount: number[] = [];
  for (const idx of candidates) {
    const s = index.staff[idx] as IndexedStaff;
    if (evidenceDay !== null && evidenceDay < s.startDay - index.startToleranceDays) {
      failedWindow.push(idx);
    } else if (linked !== undefined && !linked.has(s.entry.staffId)) {
      failedAccount.push(idx);
    } else {
      passing.push(idx);
    }
  }
  return {
    passing,
    failedWindow,
    failedAccount,
    window: evidenceDay === null ? 'not_evaluated' : 'passed',
    account: linked === undefined ? 'not_evaluated' : 'passed',
  };
}

function toStaff(
  index: RosterIndex,
  idx: number,
  method: MatchMethod,
  gates: GateOutcome,
): IdentityResolution {
  const s = index.staff[idx] as IndexedStaff;
  return {
    personKind: 'staff',
    staffId: s.entry.staffId,
    withheldReason: null,
    method,
    strength: MATCH_STRENGTH[method],
    staffIsActive: s.entry.isActive,
    gates: { window: gates.window, account: gates.account },
    excludedByGate: gates.failedWindow.length + gates.failedAccount.length,
  };
}

/** Shared tail: gates, ambiguity and resolvability for a candidate set of one tier. */
function decide(
  index: RosterIndex,
  tierSet: readonly number[],
  method: MatchMethod,
  mention: Mention,
  context: ResolutionContext | undefined,
): IdentityResolution {
  const gates = applyGates(
    index,
    tierSet,
    isoDay(mention.evidenceDate),
    context?.account?.linkedStaffIds,
  );

  if (gates.passing.length === 0) {
    const reason: QuarantineReason = gates.failedWindow.length > 0 ? 'window_gate' : 'account_gate';
    return quarantined(index, reason, tierSet, method);
  }
  if (!RESOLVABLE_METHODS.has(method)) {
    return quarantined(
      index,
      method === 'fuzzy' ? 'fuzzy_only' : 'partial_name',
      gates.passing,
      method,
    );
  }
  if (gates.passing.length > 1) {
    return quarantined(index, 'ambiguous_name', gates.passing, method);
  }
  return toStaff(index, gates.passing[0] as number, method, gates);
}

/**
 * Resolves one raw mention to a staff id, a quarantine, or an external person.
 * Pure: the roster index, the mention and the context are the only inputs.
 *
 * Order of decisions:
 *  1. extractor-flagged client-side people are never matched;
 *  2. an email is decisive when present (exact roster hit, or external by domain);
 *  3. names: the STRONGEST tier that has any candidate decides, lower tiers are
 *     ignored, so a failed exact match is never replaced by a lookalike;
 *  4. gates remove candidates of that tier; zero left = quarantined, two or more
 *     left = quarantined (ambiguous), exactly one left = staff;
 *  5. fuzzy and partial tiers can only quarantine;
 *  6. a known external with the same name makes a staff hit a quarantine.
 */
export function resolveIdentity(
  index: RosterIndex,
  mention: Mention,
  context?: ResolutionContext,
): IdentityResolution {
  if (mention.isClientSide === true) return external('client_side');

  let rawName = mention.rawName ?? '';
  let email = mention.rawEmail ? normalizeEmail(mention.rawEmail) : null;
  if (email === null && normalizeEmail(rawName) !== null) {
    email = normalizeEmail(rawName);
    rawName = '';
  }
  const forms = normalizeName(rawName);

  if (email !== null) {
    if (index.externalEmails.has(email)) return external('known_external');
    const hit = index.byEmail.get(email);
    if (hit && hit.size > 0) {
      const idxs = [...hit];
      if (idxs.length > 1) return quarantined(index, 'ambiguous_name', idxs, 'email');
      if (!nameCompatible(forms, index.staff[idxs[0] as number] as IndexedStaff)) {
        return quarantined(index, 'email_name_conflict', idxs, 'email');
      }
      return decide(index, idxs, 'email', mention, context);
    }
    if (index.agencyDomains.size > 0) {
      return external(
        index.agencyDomains.has(emailDomain(email)) ? 'unknown_agency_email' : 'external_email',
      );
    }
    // Domains not configured: the address says nothing, fall through to the name.
  }

  if (forms.tokens.length === 0) return external('unusable_name');

  // A quoted nickname is a fallback spelling: it is tried only when the written name finds nothing.
  const [written, ...hinted] = mentionVariants(forms) as [NameForms, ...NameForms[]];
  let variants: NameForms[] = [written];
  let cands = collectDeterministic(index, variants);
  if (cands.size === 0 && hinted.length > 0) {
    variants = [written, ...hinted];
    cands = collectDeterministic(index, variants);
  }
  if (cands.size === 0) cands = collectWeak(index, variants);

  const collides = variants.some((v) =>
    tokenLists(v).some((t) => exactKeysOf(t).some((k) => index.externalNameKeys.has(k))),
  );

  if (cands.size === 0) return external(collides ? 'known_external' : 'not_in_roster');

  let best: MatchMethod = 'partial';
  for (const m of cands.values()) if (rank(m) < rank(best)) best = m;
  const tierSet = [...cands.entries()].filter(([, m]) => m === best).map(([i]) => i);

  if (best === 'partial' && tierSet.length > MAX_PARTIAL_CANDIDATES) {
    return external('generic_name');
  }

  const result = decide(index, tierSet, best, mention, context);
  if (result.personKind === 'staff' && collides) {
    return quarantined(index, 'staff_external_collision', [...tierSet], best);
  }
  return result;
}
