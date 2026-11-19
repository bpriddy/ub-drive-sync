import type { PersonKind, WithheldReason } from './vocab';

/** One staff row as the caller reads it. Dates are ISO calendar dates (YYYY-MM-DD). */
export interface RosterEntry {
  readonly staffId: string;
  readonly fullName: string;
  readonly email: string | null;
  /** Preferred names, maiden names, spelling variants. Matched as full names. */
  readonly aliases?: readonly string[] | undefined;
  readonly startedAt: string;
  /** Not used as a gate (endedAt is empty for former staff); kept for callers. */
  readonly endedAt?: string | null | undefined;
  readonly isActive: boolean;
  /** false = service or tooling account: never matched. */
  readonly isPerson: boolean;
}

/** A person known to be outside the agency (client contact, vendor, earlier external row). */
export interface KnownExternal {
  readonly fullName: string;
  readonly email?: string | null | undefined;
}

export interface RosterIndexOptions {
  /**
   * Lower-case domains of the agency mailboxes. When set, an email that is not in
   * the roster is decisive: an agency-domain address is an unknown (former) employee,
   * any other domain is external. Neither is name-matched onto a lookalike.
   */
  readonly agencyEmailDomains?: readonly string[] | undefined;
  readonly knownExternals?: readonly KnownExternal[] | undefined;
}

/** What the caller has about one raw mention. Never carries ids. */
export interface Mention {
  readonly rawName: string;
  readonly rawEmail?: string | null | undefined;
  /** Flagged by the extractor: never matched to staff. */
  readonly isClientSide?: boolean | undefined;
  /** Date of the evidence (document date or period), YYYY-MM-DD. Absent = window not evaluated. */
  readonly evidenceDate?: string | null | undefined;
}

export interface ResolutionContext {
  readonly account?:
    | {
        /**
         * Staff with a recorded link to the account (team membership, earlier evidence).
         * Present = the account gate is enforced: a candidate outside the set fails it.
         * Absent = the gate is not evaluated. Where this set comes from is a caller decision.
         */
        readonly linkedStaffIds?: ReadonlySet<string> | undefined;
      }
    | undefined;
}

/** Strongest first. The first seven can resolve; `fuzzy` and `partial` only generate candidates. */
export const MATCH_METHODS = [
  'email',
  'name_exact',
  'alias',
  'name_first_last',
  'translit',
  'nickname',
  'initial',
  'fuzzy',
  'partial',
] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

/**
 * Strength of the NAME MATCH only, not a confidence about the claim. Fusion (S6)
 * owns confidence thresholds and tier corroboration. [ASSUME: ordering only;
 * the numeric values are placeholders until S6 calibrates against S5b.]
 */
export const MATCH_STRENGTH: Readonly<Record<MatchMethod, number>> = {
  email: 1,
  name_exact: 0.95,
  alias: 0.9,
  name_first_last: 0.85,
  translit: 0.8,
  nickname: 0.75,
  initial: 0.6,
  fuzzy: 0.4,
  partial: 0.3,
};

export const RESOLVABLE_METHODS: ReadonlySet<MatchMethod> = new Set(MATCH_METHODS.slice(0, 7));

export type QuarantineReason =
  | 'ambiguous_name'
  | 'window_gate'
  | 'account_gate'
  | 'fuzzy_only'
  | 'partial_name'
  | 'email_name_conflict'
  | 'staff_external_collision';

export type ExternalReason =
  | 'client_side'
  | 'not_in_roster'
  | 'unusable_name'
  | 'external_email'
  | 'unknown_agency_email'
  | 'known_external'
  | 'generic_name';

export type GateState = 'passed' | 'not_evaluated';

export interface StaffResolution {
  readonly personKind: Extract<PersonKind, 'staff'>;
  readonly staffId: string;
  readonly withheldReason: null;
  readonly method: MatchMethod;
  readonly strength: number;
  readonly staffIsActive: boolean;
  readonly gates: { readonly window: GateState; readonly account: GateState };
  /** Candidates of the deciding tier removed by a gate (the survivor was the only one left). */
  readonly excludedByGate: number;
}

export interface QuarantinedResolution {
  readonly personKind: Extract<PersonKind, 'quarantined'>;
  readonly staffId: null;
  readonly withheldReason: Extract<WithheldReason, 'ambiguous'>;
  readonly reason: QuarantineReason;
  /** Candidate staff ids, kept for audit and later corroboration. Never a decision. Capped. */
  readonly candidateStaffIds: readonly string[];
  readonly candidateCount: number;
  readonly method: MatchMethod | null;
}

export interface ExternalResolution {
  readonly personKind: Extract<PersonKind, 'external_unresolved'>;
  readonly staffId: null;
  readonly withheldReason: Extract<WithheldReason, 'unresolved'>;
  readonly reason: ExternalReason;
}

export type IdentityResolution = StaffResolution | QuarantinedResolution | ExternalResolution;
