/**
 * Mentions -> Layer 1 row drafts, through the S3 identity module.
 *
 * Everything here is deterministic and offline: it can be re-run over saved
 * model answers at $0 whenever the roster or the resolver changes. Ids, file
 * refs and project refs come from the document being processed, never from
 * the model.
 *
 *  - person: resolveIdentity (staff / quarantined / external_unresolved);
 *    a client-side mention is external_unresolved with reason client_side.
 *  - role: normalizeRole gives role_norm and seniority; the raw string is kept.
 *  - period: parsed from the model's text, then limited by the run date (starts after it:
 *    unknown, ends after it: clamped to it; see period.ts). The row still emits when the
 *    period is unknown, with NULL period fields;
 *  - evidence date for the S3 window gate: the end of the (clamped) work period,
 *    else the file's createdTime day (an upper bound of the work date, so the
 *    gate can only be lenient with it, never reject on it wrongly), else none.
 *  - confidence: the name-match strength for a staff row (placeholder until S6
 *    calibrates), 0 for a row that is withheld.
 *  - repeated claims in one document collapse by claim_hash;
 *  - claim_hash includes the ledger cell key (content version), so a changed file is a full set
 *    of new rows and fusion can keep the newest load of each file (docs/casting-fusion.md).
 */
import {
  normalizeRole,
  resolveIdentity,
  type IdentityResolution,
  type ResolutionContext,
  type RosterIndex,
} from '../identity';
import {
  claimHash,
  assertEvidenceInvariants,
  cleanText,
  type EvidenceDraft,
  type EvidenceRowShape,
} from './row';
import { clampToRunDate, parsePeriodText, runDay } from './period';
import {
  addDecision,
  buildCopyIndex,
  decideCopies,
  newCopyCounts,
  type CopyCounts,
  type CopyEdge,
} from './copies';
import type { CellRecord } from './ledger';
import type { GroundedMention } from './ground';
import { T3_SOURCE, type T3Candidate } from './types';

export interface ResolveCounts {
  mentions: number;
  duplicateClaims: number;
  byKind: Record<'staff' | 'external_unresolved' | 'quarantined', number>;
  /** Count per resolver reason (quarantine or external reason), e.g. window_gate, client_side. */
  byReason: Record<string, number>;
  /** Identical-content copies that received rows (no model call, $0). */
  copies: CopyCounts;
}

export const newResolveCounts = (): ResolveCounts => ({
  mentions: 0,
  duplicateClaims: 0,
  byKind: { staff: 0, external_unresolved: 0, quarantined: 0 },
  byReason: {},
  copies: newCopyCounts(),
});

export interface ResolveDocInput {
  readonly candidate: Pick<T3Candidate, 'fileId' | 'accountId' | 'createdTime' | 'projectRef'>;
  readonly docType: string;
  readonly mentions: readonly GroundedMention[];
  readonly index: RosterIndex;
  readonly context?: ResolutionContext | undefined;
  readonly extractorVersion: string;
  /**
   * Content version of what the mentions were read from: the ledger cell key (changes when
   * the file's md5 / modified time or the cell configuration changes). Part of every claim's
   * hash, so a changed file is written as a full new set of rows (see `claimHash`).
   */
  readonly contentVersion: string;
  readonly now: Date;
}

const day = (iso: string | null): string | null =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;

function reasonOf(r: IdentityResolution): string | null {
  return r.personKind === 'staff' ? null : r.reason;
}

export function mentionsToDrafts(input: ResolveDocInput, counts: ResolveCounts): EvidenceDraft[] {
  const out: EvidenceDraft[] = [];
  const seen = new Set<string>();
  for (const raw of input.mentions) {
    counts.mentions++;
    // Ledgers written before the parser cleaned control characters can hold a NUL,
    // which Postgres text rejects: clean every text field the row stores or hashes.
    const m = {
      ...raw,
      rawName: cleanText(raw.rawName),
      rawRole: cleanText(raw.rawRole),
      quote: cleanText(raw.quote),
      location: cleanText(raw.location),
      periodText: cleanText(raw.periodText),
    };
    // What the text says is the claim's identity; what the row stores is limited by the run date.
    const stated = parsePeriodText(m.periodText, input.now);
    const period = clampToRunDate(stated, runDay(input.now));
    const evidenceDate = period.end ?? period.start ?? day(input.candidate.createdTime);
    const res = resolveIdentity(
      input.index,
      { rawName: m.rawName, isClientSide: m.isClientSide, evidenceDate },
      input.context,
    );
    const role = normalizeRole(m.rawRole);
    const base = {
      raw_name: m.rawName,
      account_id: input.candidate.accountId,
      job_number: input.candidate.projectRef?.jobNumber ?? null,
      campaign_id: input.candidate.projectRef?.campaignId ?? null,
      piece_id: input.candidate.projectRef?.pieceId ?? null,
      role_raw: m.rawRole,
      role_norm: role.roleNorm,
      seniority: role.seniority,
      period_start: period.start,
      period_end: period.end,
      source: T3_SOURCE,
      file_id: input.candidate.fileId,
      location: m.location,
      quote: m.quote,
      extractor_version: input.extractorVersion,
    };
    // Hashed on the stated period, not the clamped one: a clamped end moves with the run
    // day and would give the same claim a new hash on every later run. The content version
    // makes a changed file's claims new rows even when a claim reads the same as before.
    const hash = claimHash(
      { ...base, period_start: stated.start, period_end: stated.end },
      input.contentVersion,
    );
    if (seen.has(hash)) {
      counts.duplicateClaims++;
      continue;
    }
    seen.add(hash);
    const row: EvidenceRowShape =
      res.personKind === 'staff'
        ? {
            ...base,
            staff_id: res.staffId,
            person_kind: 'staff',
            confidence: res.strength,
            withheld_reason: null,
            claim_hash: hash,
          }
        : {
            ...base,
            staff_id: null,
            person_kind: res.personKind,
            confidence: 0,
            withheld_reason: res.withheldReason,
            claim_hash: hash,
          };
    assertEvidenceInvariants(row);
    counts.byKind[res.personKind]++;
    const reason = reasonOf(res);
    if (reason) counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
    out.push({
      row,
      meta: {
        docType: input.docType,
        matchMethod: 'method' in res ? res.method : null,
        resolutionReason: reason,
        candidateStaffIds: res.personKind === 'quarantined' ? res.candidateStaffIds : [],
      },
    });
  }
  return out;
}

/** The newest ok record of each cell; `keys` null = every cell. */
export function latestOk(
  records: readonly CellRecord[],
  keys: ReadonlySet<string> | null,
): CellRecord[] {
  const byKey = new Map<string, CellRecord>();
  for (const r of records) {
    if (r.status === 'ok' && (keys === null || keys.has(r.cellKey))) byKey.set(r.cellKey, r);
  }
  return [...byKey.values()];
}

export interface ResolveLedgerInput {
  readonly roster: RosterIndex;
  readonly contextFor?: ((accountId: string) => ResolutionContext | undefined) | undefined;
  /** The run date: limits the stored period (see period.ts). */
  readonly now: Date;
  /** md5 copies of the current selection (the ledger's own `copy` lines are always used). */
  readonly selectionEdges: readonly CopyEdge[];
  /** Cells to resolve; null = every ok cell of the ledger. */
  readonly selectedKeys: ReadonlySet<string> | null;
}

/**
 * The stage's resolve step over saved ledger cells ($0, no model): the rows of every ok
 * cell, then the rows of its identical-content copies (the kept file's mentions, the
 * copy's own file, account and project reference). Shared by the stage's apply and
 * dry-run preview and by the ledger loader, so both build the same rows. Rows are
 * stamped with the ledger record's own extractor version, never the current code's.
 */
export function resolveLedgerRecords(
  records: readonly CellRecord[],
  input: ResolveLedgerInput,
  counts: ResolveCounts,
): EvidenceDraft[] {
  const drafts: EvidenceDraft[] = [];
  const index = buildCopyIndex(records, input.selectionEdges);
  for (const rec of latestOk(records, input.selectedKeys)) {
    const common = {
      docType: rec.docType ?? 'other',
      mentions: rec.mentions,
      index: input.roster,
      extractorVersion: rec.extractorVersion,
      // A copy shares the kept cell's content, so it carries the kept cell's key.
      contentVersion: rec.cellKey,
      now: input.now,
    };
    drafts.push(
      ...mentionsToDrafts(
        {
          ...common,
          candidate: rec.candidate,
          context: input.contextFor?.(rec.candidate.accountId),
        },
        counts,
      ),
    );
    // Identical-content copies: the kept file's mentions, the copy's own file and context.
    const decision = decideCopies(rec.candidate.fileId, index.get(rec.cellKey) ?? []);
    addDecision(counts.copies, decision);
    for (const copy of decision.expand) {
      const rows = mentionsToDrafts(
        {
          ...common,
          candidate: {
            fileId: copy.fileId,
            accountId: copy.accountId,
            createdTime: copy.createdTime,
            projectRef: copy.projectRef,
          },
          context: input.contextFor?.(copy.accountId),
        },
        counts,
      );
      counts.copies.rows += rows.length;
      drafts.push(...rows);
    }
  }
  return drafts;
}
