/**
 * Layer 1 `evidence` row, as this stage writes it.
 *
 * `EvidenceRowShape` is repo-local: it is the package's `EvidenceRow` minus the
 * columns the DB and the sink assign (`id`, `created_at`, `sync_run_id`), with
 * `source` narrowed to this tier. `EVIDENCE_QUOTE_MAX_CHARS` is the package's
 * (gub-schemas 1.26.0). `assertEvidenceInvariants` asserts the same row-level
 * CHECKs as the package's `evidenceRowSchema` refinements, on the stage's shape.
 *
 * Wire format: snake_case, ISO dates (YYYY-MM-DD). A Prisma writer maps these
 * to the camelCase model fields.
 */
import crypto from 'node:crypto';
import { EVIDENCE_QUOTE_MAX_CHARS } from '@anomaly-technology/gub-schemas';
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

export { EVIDENCE_QUOTE_MAX_CHARS };

/** C0 control characters and DEL, NUL included: Postgres text rejects 0x00 (22021). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Replace control characters with a space and collapse whitespace; null stays null. */
export function cleanText(s: string): string;
export function cleanText(s: string | null): string | null;
export function cleanText(s: string | null): string | null {
  if (s === null) return null;
  return s.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

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
 * period, and the content version of the file when given): the idempotency key
 * together with extractor_version.
 *
 * `contentVersion` is the ledger cell key of the cell the claim was read from (file +
 * Drive md5, or the modified time of a Google-native file, + the cell configuration).
 * It changes exactly when the content that was read changes, so a changed file hashes
 * EVERY claim anew and one load writes the full set of its newest version, while a load
 * of the same ledger again hashes the same and inserts nothing twice. Fusion keeps only
 * the newest load of a file (docs/casting-fusion.md). Without it (null / undefined) the
 * canonical form is the one rows had before the token existed, so those rows keep
 * their hash; nothing but the T3 resolve step passes it.
 */
export function claimHash(
  r: Pick<
    EvidenceRowShape,
    'source' | 'file_id' | 'location' | 'raw_name' | 'role_raw' | 'period_start' | 'period_end'
  >,
  contentVersion?: string | null,
): string {
  const parts: string[] = [
    r.source,
    r.file_id,
    norm(r.location),
    norm(r.raw_name),
    norm(r.role_raw),
    r.period_start ?? '',
    r.period_end ?? '',
  ];
  if (contentVersion !== undefined && contentVersion !== null) parts.push(contentVersion);
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
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
