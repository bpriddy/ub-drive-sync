/**
 * Layer 1 `evidence` row, as this stage writes it.
 *
 * MIRROR of gub-schemas `src/casting.ts` (unpublished 1.23.0; row shapes read
 * at source commit d8e7042 of the local gub-schemas epic). Declared here only
 * because that version is not pinned in package.json yet. After the pin:
 * delete `EvidenceRowShape`, `EVIDENCE_QUOTE_MAX_CHARS` and `assertEvidenceInvariants`
 * and use `EvidenceRow`, `EVIDENCE_QUOTE_MAX_CHARS` and `evidenceRowSchema`
 * from '@anomaly-technology/gub-schemas' (the schema's refinements are the same
 * row-level CHECKs asserted below); the closed sets already come from the
 * identity module's mirror, which has its own drift test.
 *
 * Wire format: snake_case, ISO dates (YYYY-MM-DD). A Prisma writer maps these
 * to the camelCase model fields.
 */
import crypto from 'node:crypto';
import {
  PERSON_KINDS,
  ROLE_NORMS,
  SENIORITIES,
  WITHHELD_REASONS,
  type PersonKind,
  type RoleNorm,
  type Seniority,
  type WithheldReason,
} from '../identity';

export const EVIDENCE_QUOTE_MAX_CHARS = 300;

/** What the stage computes. The DB assigns `id` and `created_at`; the sink adds `sync_run_id`. */
export interface EvidenceRowShape {
  staff_id: string | null;
  raw_name: string;
  person_kind: PersonKind;
  account_id: string;
  job_number: string | null;
  campaign_id: string | null;
  piece_id: string | null;
  role_raw: string | null;
  role_norm: RoleNorm | null;
  seniority: Seniority | null;
  period_start: string | null;
  period_end: string | null;
  source: 'drive_content';
  file_id: string;
  location: string | null;
  quote: string | null;
  confidence: number;
  withheld_reason: WithheldReason | null;
  extractor_version: string;
  claim_hash: string;
}

/** Facts about a row that the table has no column for. Never persisted by this stage. */
export interface EvidenceRowMeta {
  readonly docType: string;
  readonly matchMethod: string | null;
  readonly resolutionReason: string | null;
  readonly candidateStaffIds: readonly string[];
}

export interface EvidenceDraft {
  readonly row: EvidenceRowShape;
  readonly meta: EvidenceRowMeta;
}

const norm = (s: string | null): string =>
  (s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Hash over the claim's identity (source, file, location, raw name, raw role,
 * period): the idempotency key together with extractor_version.
 */
export function claimHash(
  r: Pick<
    EvidenceRowShape,
    'source' | 'file_id' | 'location' | 'raw_name' | 'role_raw' | 'period_start' | 'period_end'
  >,
): string {
  const canonical = JSON.stringify([
    r.source,
    r.file_id,
    norm(r.location),
    norm(r.raw_name),
    norm(r.role_raw),
    r.period_start ?? '',
    r.period_end ?? '',
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** The table's row-level CHECKs and closed sets. Throws on the first violation. */
export function assertEvidenceInvariants(r: EvidenceRowShape): void {
  const fail = (m: string): never => {
    throw new Error(`evidence invariant: ${m}`);
  };
  if (!(PERSON_KINDS as readonly string[]).includes(r.person_kind)) fail('person_kind');
  if ((r.person_kind === 'staff') !== (r.staff_id !== null)) fail('staff_id iff staff');
  if (r.person_kind !== 'staff' && r.withheld_reason === null)
    fail('non-staff needs withheld_reason');
  if (
    r.withheld_reason !== null &&
    !(WITHHELD_REASONS as readonly string[]).includes(r.withheld_reason)
  ) {
    fail('withheld_reason');
  }
  if (r.role_norm !== null && !(ROLE_NORMS as readonly string[]).includes(r.role_norm))
    fail('role_norm');
  if (r.seniority !== null && !(SENIORITIES as readonly string[]).includes(r.seniority))
    fail('seniority');
  if (r.quote !== null && r.quote.length > EVIDENCE_QUOTE_MAX_CHARS) fail('quote length');
  if (!(r.confidence >= 0 && r.confidence <= 1)) fail('confidence range');
  if (r.period_start !== null && r.period_end !== null && r.period_end < r.period_start) {
    fail('period order');
  }
  if (r.raw_name.length === 0 || r.file_id.length === 0 || r.extractor_version.length === 0) {
    fail('empty required text');
  }
}
