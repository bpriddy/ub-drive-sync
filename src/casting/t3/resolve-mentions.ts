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
 *  - evidence date for the S3 window gate: the end of the parsed work period,
 *    else the file's createdTime day (an upper bound of the work date, so the
 *    gate can only be lenient with it, never reject on it wrongly), else none.
 *  - confidence: the name-match strength for a staff row (placeholder until S6
 *    calibrates), 0 for a row that is withheld.
 *  - repeated claims in one document collapse by claim_hash.
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
  type EvidenceDraft,
  type EvidenceRowShape,
} from './row';
import { parsePeriod } from './period';
import { newCopyCounts, type CopyCounts } from './copies';
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
  for (const m of input.mentions) {
    counts.mentions++;
    const period = parsePeriod(m.periodText, input.now);
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
    const hash = claimHash(base);
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
