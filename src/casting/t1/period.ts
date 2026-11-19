/**
 * Project period for T1 evidence.
 *
 * The period is a property of the PROJECT, never of one file. Sources, in
 * order of preference:
 *
 *   1. folder_year: years written in the folder names around the project
 *      ("2025", "2019-2021", "FY24", "2025 BTS"), the deepest folder that has
 *      any. Year granularity: Jan 1 of the first year to Dec 31 of the last.
 *   2. campaign_dates: the campaign row's own dates (awarded / live / ends),
 *      when the project resolves to a campaign. [ASSUME: these dates are
 *      curated well enough; measure on S4.5.]
 *   3. file_dates: a robust window over the project's file modified times: the
 *      10th to 90th percentile by month, only when enough files carry a usable
 *      date. Weakest: re-used older assets and bulk uploads still skew it.
 *   4. none: the period stays NULL. A wrong period is worse than none.
 *
 * Never used: `createdTime` (80% of files in some drives were created after
 * they were modified; migration days stamp whole drives), and any date that
 * is a placeholder (1980-01-01 and anything before 1990) or in the future.
 *
 * The 5-year window: a period that ends before `windowStart` is out of scope;
 * one that straddles it is truncated at `windowStart` (pitfall register, "a
 * project straddling the cutoff is included with a truncated period").
 */
import type { CampaignInfo } from './types';

export type PeriodBasis = 'folder_year' | 'campaign_dates' | 'file_dates' | 'none';

export interface Period {
  /** YYYY-MM-DD */
  start: string | null;
  end: string | null;
  basis: PeriodBasis;
}

export const NO_PERIOD: Period = { start: null, end: null, basis: 'none' };

/** Anything earlier is a placeholder, not a date (the epoch placeholder 1980-01-01 included). */
export const MIN_PLAUSIBLE_YEAR = 1990;
/** Dated files a project needs before its file dates may define a period. [ASSUME: 8; tune on S4.5.] */
export const MIN_DATED_FILES_FOR_WINDOW = 8;
/** Percentiles of the monthly histogram that bound the window. [ASSUME] */
export const WINDOW_LOW_PERCENTILE = 0.1;
export const WINDOW_HIGH_PERCENTILE = 0.9;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function isoDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A usable file date, or null (missing, invalid, placeholder or in the future). */
export function usableDate(d: Date | null, today: Date): Date | null {
  if (d === null || Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() < MIN_PLAUSIBLE_YEAR) return null;
  if (d.getTime() > today.getTime() + 86_400_000) return null;
  return d;
}

/** Months since year 0, for the histogram key. */
export const monthIndex = (d: Date): number => d.getUTCFullYear() * 12 + d.getUTCMonth();

function monthStart(idx: number): string {
  return `${pad(Math.floor(idx / 12), 4)}-${pad((idx % 12) + 1)}-01`;
}

function monthEnd(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = idx % 12;
  return isoDate(new Date(Date.UTC(y, m + 1, 0)));
}

// ── folder years ────────────────────────────────────────────────────────────

const YEAR_TOKEN = /(?<!\d)((?:19|20)\d{2})(?!\d)/g;
const FY_TOKEN = /(?<![A-Za-z0-9])FY\s?(\d{2})(?!\d)/gi;

/** Years in one folder name. A job code's digits are not years. */
export function yearsInSegment(segment: string, today: Date): number[] {
  // Blank out job codes so "ACME2025" or "[ACME55002025-01]" is not read as a year.
  const text = segment
    .replace(/\[[A-Z]{2,10}\d{4,14}[^\]]*\]/g, ' ')
    .replace(/(?<![A-Za-z0-9])[A-Z]{2,10}\d{4,14}(?![A-Za-z0-9])/g, ' ');

  // A future year names planned work, not work that happened: not a period.
  const max = today.getUTCFullYear();
  const years = new Set<number>();
  for (const m of text.matchAll(YEAR_TOKEN)) years.add(Number(m[1]));
  for (const m of text.matchAll(FY_TOKEN)) years.add(2000 + Number(m[1]));
  return [...years].filter((y) => y >= MIN_PLAUSIBLE_YEAR && y <= max).sort((a, b) => a - b);
}

/** The deepest folder with any year decides: its first to last year. */
export function folderYearPeriod(segments: readonly string[], today: Date): Period {
  for (let i = segments.length - 1; i >= 0; i--) {
    const years = yearsInSegment(segments[i] as string, today);
    if (years.length > 0) {
      const first = years[0] as number;
      const last = years[years.length - 1] as number;
      const end = new Date(Date.UTC(last, 11, 31));
      // The latest allowed year is the current one, so start <= today always.
      return {
        start: `${pad(first, 4)}-01-01`,
        end: isoDate(end.getTime() > today.getTime() ? today : end),
        basis: 'folder_year',
      };
    }
  }
  return NO_PERIOD;
}

// ── campaign dates ──────────────────────────────────────────────────────────

/**
 * Awarded (else live) to ends. Needs at least a start; an end before the start
 * is ignored. A start later than `today` (the run date, injected so re-runs and
 * tests are deterministic) is a planned campaign, not work that happened: the
 * source yields no period and the caller falls through to the next one. A start
 * on `today` itself is accepted. The end is passed through as stored (it may lie
 * in the future for a running campaign).
 */
export function campaignDatePeriod(campaign: CampaignInfo | undefined, today: Date): Period {
  if (!campaign) return NO_PERIOD;
  const start = campaign.awardedAt ?? campaign.liveAt;
  if (start === null) return NO_PERIOD;
  if (start > isoDate(today)) return NO_PERIOD;
  const end = campaign.endsAt !== null && campaign.endsAt >= start ? campaign.endsAt : null;
  return { start, end, basis: 'campaign_dates' };
}

// ── file-date window ────────────────────────────────────────────────────────

/** Month histogram of the usable modified dates of one project. Bounded by months, not files. */
export class DateHistogram {
  private readonly months = new Map<number, number>();
  private total = 0;

  add(d: Date): void {
    const k = monthIndex(d);
    this.months.set(k, (this.months.get(k) ?? 0) + 1);
    this.total += 1;
  }

  get count(): number {
    return this.total;
  }

  private quantileMonth(q: number): number {
    const sorted = [...this.months.entries()].sort((a, b) => a[0] - b[0]);
    const target = Math.max(1, Math.ceil(q * this.total));
    let seen = 0;
    for (const [month, n] of sorted) {
      seen += n;
      if (seen >= target) return month;
    }
    return (sorted[sorted.length - 1] as [number, number])[0];
  }

  window(minFiles: number = MIN_DATED_FILES_FOR_WINDOW): Period {
    if (this.total < minFiles) return NO_PERIOD;
    const lo = this.quantileMonth(WINDOW_LOW_PERCENTILE);
    const hi = this.quantileMonth(WINDOW_HIGH_PERCENTILE);
    return { start: monthStart(lo), end: monthEnd(Math.max(lo, hi)), basis: 'file_dates' };
  }
}

// ── combination and cutoff ──────────────────────────────────────────────────

/**
 * Applies the 5-year window. Returns null when the period lies wholly before
 * `windowStart` (the project is out of scope); otherwise the period with its
 * start raised to `windowStart` when it began earlier. An unknown period passes.
 */
export function applyWindow(period: Period, windowStart: string | null): Period | null {
  if (windowStart === null) return period;
  if (period.end !== null && period.end < windowStart) return null;
  if (period.start !== null && period.start < windowStart) {
    return { ...period, start: windowStart };
  }
  return period;
}

export function yearOf(period: Period): number | null {
  return period.start === null ? null : Number(period.start.slice(0, 4));
}
