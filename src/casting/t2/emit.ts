/**
 * T2 activity evidence: one weak Layer 1 row per (file, actor, calendar month)
 * of `drive_edit_stats`, tied to the file's project.
 *
 * What a row says: "this person's account edited a file of this project in
 * this month". It does not say the person worked on the project, in what role
 * (role_raw, role_norm, seniority stay NULL), or on which day. Fusion (S6)
 * must treat T2 as corroboration of T3, never as proof.
 *
 * Grain. A month, not a day: day-grain would multiply rows by the number of
 * editing days for a signal that is weak anyway. `period_start` and
 * `period_end` are the month's first and last day, a deterministic function of
 * the claim, so a re-run produces the identical row. Only CLOSED months (before
 * the month of the run date) are emitted; the open month is picked up by a
 * later run. The edit and day counts go into `location` as audit text; they
 * are NOT part of the claim hash, so a later run that sees more edits in an
 * already emitted month inserts nothing (append-only, first count stays).
 *
 * Dates. `drive_edit_stats.day` is the day of the run that counted the edits
 * (a daily forward run, or the END of a 30-day seed window), not the edit day:
 * the real edit is on or before it. The month is therefore a bound, off by at
 * most the run's window (about a day for forward runs [ASSUME: daily tick],
 * up to 30 days for seed windows). The S3 employment-window gate is evaluated
 * on the group's LAST stats day (the lenient end: an edit that late is
 * plausible, an earlier one might not be).
 *
 * Coverage limits, restated so nobody reads absence as a finding:
 *   - events exist only from when the Activity seed starts (the Activity
 *     horizon is drive age, not a Google cliff; widening the seed is a
 *     separate ops step, see docs/casting-t2-activity.md);
 *   - migrated content has NO events: files copied or imported from an older
 *     drive show the import, not the original work;
 *   - a large share of actors stays `people/<id>` because the directory
 *     lookup misses (deleted or external people). They are counted, not
 *     emitted. [MEASURE: S4.5 dry-run per account and year]
 *
 * Every confidence below is an [ASSUME] placeholder until S6 calibrates it
 * against the pilot. A single T2 row must stay far below the serving
 * threshold (0.7).
 */
import { createHash } from 'node:crypto';
import type { IdentityResolution } from '../identity';
import { assertEvidenceInvariants } from '../t1/emit';
import { monthEnd, monthOfDay, monthStart } from './months';
import type { T2Project } from './project';
import type { EvidenceInsertRow, StatsGroup } from './types';
import { T2_EXTRACTOR_VERSION } from './types';

/** [ASSUME: placeholders. The ceiling is the decision: T2 alone never nears 0.7.] */
export const T2_BASE_CONFIDENCE = 0.1;
/** [ASSUME] bonus for repeated editing in the month. */
export const T2_EDITS_BONUS = 0.04;
export const T2_EDITS_BONUS_AT = 10;
/** [ASSUME] bonus for several distinct days in the month. */
export const T2_DAYS_BONUS = 0.04;
export const T2_DAYS_BONUS_AT = 3;
export const T2_MAX_CONFIDENCE =
  Math.round((T2_BASE_CONFIDENCE + T2_EDITS_BONUS + T2_DAYS_BONUS) * 1000) / 1000;

export function confidenceOf(group: Pick<StatsGroup, 'edits' | 'days'>): number {
  let c = T2_BASE_CONFIDENCE;
  if (group.edits >= T2_EDITS_BONUS_AT) c += T2_EDITS_BONUS;
  if (group.days >= T2_DAYS_BONUS_AT) c += T2_DAYS_BONUS;
  return Math.round(c * 1000) / 1000;
}

/** The month key inside the claim: `activity:YYYY-MM`. */
export const claimMonthKey = (month: string): string => `activity:${month}`;

/**
 * The claim hash: identity of the claim across runs, so a re-run inserts nothing.
 * Covers source, file, month key, raw name (the email), raw role (always empty)
 * and the project reference. It does NOT cover edit counts or day counts.
 */
export function claimHash(parts: {
  fileId: string;
  month: string;
  rawName: string;
  projectKey: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'drive_activity',
        parts.fileId,
        claimMonthKey(parts.month),
        parts.rawName,
        '',
        parts.projectKey,
      ]),
    )
    .digest('hex');
}

export interface EmitContext {
  accountId: string;
  syncRunId: string;
  month: string;
  project: T2Project;
  email: string;
  resolution: IdentityResolution;
}

export function emitActivityRow(group: StatsGroup, ctx: EmitContext): EvidenceInsertRow {
  if (monthOfDay(group.lastDay) !== ctx.month || monthOfDay(group.firstDay) !== ctx.month) {
    throw new Error('stats group outside its month: reader bug');
  }
  const location = `${claimMonthKey(ctx.month)};edits=${group.edits};days=${group.days}`;
  const row: EvidenceInsertRow = {
    staffId: ctx.resolution.staffId,
    rawName: ctx.email,
    personKind: ctx.resolution.personKind,
    accountId: ctx.accountId,
    jobNumber: ctx.project.jobNumber,
    campaignId: ctx.project.campaignId,
    pieceId: ctx.project.pieceId,
    roleRaw: null,
    roleNorm: null,
    seniority: null,
    periodStart: monthStart(ctx.month),
    periodEnd: monthEnd(ctx.month),
    source: 'drive_activity',
    fileId: group.fileId,
    location,
    quote: null,
    confidence: confidenceOf(group),
    withheldReason: ctx.resolution.withheldReason,
    extractorVersion: T2_EXTRACTOR_VERSION,
    syncRunId: ctx.syncRunId,
    claimHash: claimHash({
      fileId: group.fileId,
      month: ctx.month,
      rawName: ctx.email,
      projectKey: ctx.project.key,
    }),
  };
  assertEvidenceInvariants(row);
  return row;
}
