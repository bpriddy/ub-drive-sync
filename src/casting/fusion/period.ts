/**
 * Claim period, derived from project context. Never from one file's date.
 *
 * In order, the first source that has a period wins:
 *   1. content:  the envelope (earliest start, latest end) of the periods that the
 *                claim's own T3 rows state (the document said when the person worked);
 *   2. project:  the envelope of the periods of every T1 row of the project (any
 *                person): T1 derives it from folder years, campaign dates or a robust
 *                window over many files, so it is the project's, not a file's;
 *   3. campaign: the catalog campaign's own dates (awarded, else live, to ends);
 *   4. none:     NULL. A wrong period is worse than none.
 *
 * T2 months are NOT a source. A T2 stats day is the day of the RUN that counted
 * the edits, an upper bound of the edit date, never an event day; using it as a
 * period would date the work by the day someone happened to run the job.
 *
 * Every input is a plain value and the result is a min / max envelope, so the
 * order of the rows cannot change it.
 */
import type { FusionCampaign, FusionEvidence } from './types';

export interface ClaimPeriod {
  start: string | null;
  end: string | null;
  basis: 'content' | 'project' | 'campaign' | 'none';
}

export const NO_CLAIM_PERIOD: ClaimPeriod = { start: null, end: null, basis: 'none' };

/** Envelope of the rows that have BOTH dates and are ordered; null when none does. */
export function envelope(
  rows: readonly Pick<FusionEvidence, 'periodStart' | 'periodEnd'>[],
): { start: string; end: string } | null {
  let start: string | null = null;
  let end: string | null = null;
  for (const r of rows) {
    if (r.periodStart === null || r.periodEnd === null || r.periodEnd < r.periodStart) continue;
    if (start === null || r.periodStart < start) start = r.periodStart;
    if (end === null || r.periodEnd > end) end = r.periodEnd;
  }
  return start === null || end === null ? null : { start, end };
}

export function campaignPeriod(
  campaign: Pick<FusionCampaign, 'awardedAt' | 'liveAt' | 'endsAt'> | null,
): { start: string; end: string | null } | null {
  if (campaign === null) return null;
  const start = campaign.awardedAt ?? campaign.liveAt;
  if (start === null) return null;
  const end = campaign.endsAt !== null && campaign.endsAt >= start ? campaign.endsAt : null;
  return { start, end };
}

export function deriveClaimPeriod(args: {
  /** The claim's own T3 rows. */
  contentRows: readonly FusionEvidence[];
  /** Every T1 row of the project, any person. */
  projectT1Rows: readonly FusionEvidence[];
  campaign: FusionCampaign | null;
}): ClaimPeriod {
  const content = envelope(args.contentRows);
  if (content !== null) return { ...content, basis: 'content' };
  const project = envelope(args.projectT1Rows);
  if (project !== null) return { ...project, basis: 'project' };
  const camp = campaignPeriod(args.campaign);
  if (camp !== null) return { start: camp.start, end: camp.end, basis: 'campaign' };
  return NO_CLAIM_PERIOD;
}

/** YYYY-MM-DD plus a whole number of days (negative = earlier), UTC. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Do two periods overlap? An unknown bound is treated as overlapping (the conservative answer). */
export function periodsOverlap(
  a: { start: string | null; end: string | null },
  b: { start: string | null; end: string | null },
): boolean {
  if (a.start === null || b.start === null) return true;
  const aEnd = a.end ?? '9999-12-31';
  const bEnd = b.end ?? '9999-12-31';
  return a.start <= bEnd && b.start <= aEnd;
}
