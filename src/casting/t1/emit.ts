/**
 * T1 presence evidence: one weak Layer 1 row per indexed file whose last
 * modifier is known, tied to the file's project.
 *
 * What a row says: "this person last modified a file in this project's
 * folder". It does not say the person worked on the project, in what role, or
 * when: the file's modified time is unreliable for that (uploads keep their
 * source time while the modifier is the uploader), so the identity window gate
 * is deliberately not evaluated, and no role is stated (role_raw, role_norm,
 * seniority stay NULL). Fusion (S6) must treat T1 as corroboration of T3.
 *
 * Coverage limits, by measurement on real drives, restated here so nobody
 * reads absence as a finding:
 *   - shared drives return no `owners`, and the file index has no creator
 *     column, so there is NO creator evidence at all;
 *   - the last modifier is missing on roughly 30 to 85 percent of documents
 *     and the share rises with file age, which looks like departed people.
 *     T1 is nearly blind to leavers' work. [MEASURE: S4.5 dry-run per account and year]
 *
 * Every confidence below is an [ASSUME] placeholder until S6 calibrates it
 * against the pilot.
 */
import { createHash } from 'node:crypto';
import type { IdentityResolution } from '../identity';
import type { Period } from './period';
import type { ProjectSkeleton } from './skeleton';
import type { IndexFileRow, EvidenceInsertRow } from './types';
import { EVIDENCE_QUOTE_MAX_CHARS, T1_EXTRACTOR_VERSION } from './types';

/** [ASSUME: placeholders. Ordering is the decision: a strict job code beats a campaign beats a name.] */
export const T1_BASE_CONFIDENCE: Readonly<Record<ProjectSkeleton['strength'], number>> = {
  job_code: 0.3,
  job_code_weak: 0.22,
  campaign: 0.25,
  name_key: 0.15,
  none: 0,
};

/** [ASSUME] multiplier by how the period was derived. */
export const T1_PERIOD_FACTOR: Readonly<Record<Period['basis'], number>> = {
  folder_year: 1,
  campaign_dates: 1,
  file_dates: 0.8,
  none: 0.7,
};

/** Mime types that are not content a person edited. */
const SKIPPED_MIME = new Set([
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.shortcut',
]);

/** Max length of the location text on name-keyed rows (the project's name key). */
const LOCATION_MAX_CHARS = 200;

export type SkipReason = 'not_content' | 'no_modifier' | 'no_project' | 'out_of_window';

export function confidenceOf(project: ProjectSkeleton): number {
  const c = T1_BASE_CONFIDENCE[project.strength] * T1_PERIOD_FACTOR[project.period.basis];
  return Math.round(c * 1000) / 1000;
}

/**
 * The claim hash: identity of the claim across runs, so a re-run inserts nothing.
 * Covers source, file, location, raw name, raw role and project reference.
 * It does NOT cover the period: a period is derived from the whole project and
 * moves as files arrive, which would turn every re-run into a duplicate batch.
 * Existing rows are append-only, so a changed period reaches only new claims;
 * a change of derivation rules bumps `T1_EXTRACTOR_VERSION` instead.
 */
export function claimHash(parts: {
  source: string;
  fileId: string;
  location: string | null;
  rawName: string;
  roleRaw: string | null;
  projectKey: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        parts.source,
        parts.fileId,
        parts.location ?? '',
        parts.rawName,
        parts.roleRaw ?? '',
        parts.projectKey,
      ]),
    )
    .digest('hex');
}

export interface EmitContext {
  accountId: string;
  syncRunId: string;
  project: ProjectSkeleton;
  nameKey: string | null;
  resolve: (email: string) => IdentityResolution;
}

export type EmitResult =
  { row: EvidenceInsertRow; skipped?: undefined } | { row?: undefined; skipped: SkipReason };

/** A folder or shortcut entry: not content a person edited, and no evidence about a project either. */
export function isNotContent(file: IndexFileRow): boolean {
  return file.mimeType !== null && SKIPPED_MIME.has(file.mimeType);
}

/** Pre-checks that need no project: is this file a candidate at all. */
export function candidateSkip(file: IndexFileRow): SkipReason | null {
  if (isNotContent(file)) return 'not_content';
  if (file.modifiedBy === null || file.modifiedBy.trim() === '') return 'no_modifier';
  return null;
}

export function emitPresenceRow(file: IndexFileRow, ctx: EmitContext): EmitResult {
  const pre = candidateSkip(file);
  if (pre !== null) return { skipped: pre };
  if (ctx.project.outOfWindow) return { skipped: 'out_of_window' };

  const email = (file.modifiedBy as string).trim().toLowerCase();
  const resolution = ctx.resolve(email);

  // A name-keyed project has no durable id: the key goes into `location`.
  const location = ctx.nameKey === null ? null : `name:${ctx.nameKey}`.slice(0, LOCATION_MAX_CHARS);

  const row: EvidenceInsertRow = {
    staffId: resolution.staffId,
    rawName: email,
    personKind: resolution.personKind,
    accountId: ctx.accountId,
    jobNumber: ctx.project.jobNumber,
    campaignId: ctx.project.campaignId,
    pieceId: ctx.project.pieceId,
    roleRaw: null,
    roleNorm: null,
    seniority: null,
    periodStart: ctx.project.period.start,
    periodEnd: ctx.project.period.end,
    source: 'drive_metadata',
    fileId: file.fileId,
    location,
    quote: null,
    confidence: confidenceOf(ctx.project),
    withheldReason: resolution.withheldReason,
    extractorVersion: T1_EXTRACTOR_VERSION,
    syncRunId: ctx.syncRunId,
    claimHash: claimHash({
      source: 'drive_metadata',
      fileId: file.fileId,
      location,
      rawName: email,
      roleRaw: null,
      projectKey: ctx.project.key,
    }),
  };
  assertEvidenceInvariants(row);
  return { row };
}

/**
 * The row-level CHECKs of the evidence table, mirrored (gub-schemas f8cf59f,
 * `DB CHECK evidence_*`). A violation is a bug in this stage, never data.
 */
export function assertEvidenceInvariants(row: EvidenceInsertRow): void {
  const fail = (msg: string): never => {
    throw new Error(`evidence row invariant violated: ${msg}`);
  };
  if (row.rawName.length === 0) fail('raw_name is empty');
  if (row.fileId.length === 0) fail('file_id is empty');
  if (!(row.confidence >= 0 && row.confidence <= 1)) fail('confidence outside 0..1');
  if (row.periodStart !== null && row.periodEnd !== null && row.periodEnd < row.periodStart) {
    fail('period_end precedes period_start');
  }
  if ((row.personKind === 'staff') !== (row.staffId !== null)) {
    fail('staff_id is set exactly when person_kind is staff');
  }
  if (row.personKind !== 'staff' && row.withheldReason === null) {
    fail('a non-staff row needs a withheld_reason');
  }
  if (row.quote !== null && row.quote.length > EVIDENCE_QUOTE_MAX_CHARS) fail('quote too long');
}
