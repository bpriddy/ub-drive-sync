/**
 * Window planning for the backfill: contiguous windows from `from` to `to`,
 * oldest first, each a half-open day range (start, end] at 00:00:00Z. The
 * rows of a window are dated by the window END, as the existing seed does
 * (run-date framing, src/forward/stats.ts).
 */
import { createHash } from 'node:crypto';
import {
  type BackfillWindow,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOWS,
  MAX_WINDOW_DAYS,
  ACTIVITY_PAGE_SIZE,
} from './types';

const DAY_MS = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function dayNumber(day: string): number {
  if (!ISO.test(day)) throw new RangeError(`not a YYYY-MM-DD date: ${day}`);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new RangeError(`not a calendar date: ${day}`);
  }
  return ms / DAY_MS;
}

export function dayString(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Deterministic run id of one window: a name-based UUID (version 5 layout) over
 * a hash of account and the window bounds. Same account and bounds, same id,
 * so a retry replaces exactly its own rows.
 */
export function windowRunId(accountId: string, fromIso: string, toIso: string): string {
  const h = createHash('sha256')
    .update(`casting-t2-backfill-v1|${accountId.toLowerCase()}|${fromIso}|${toIso}`)
    .digest('hex');
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface PlanInput {
  accountId: string;
  /** YYYY-MM-DD */
  from: string;
  /** YYYY-MM-DD */
  to: string;
  windowDays?: number | undefined;
  /** The run date: `to` must not be later than it. */
  today: Date;
}

export function planWindows(input: PlanInput): BackfillWindow[] {
  const n = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) {
    throw new RangeError(`windowDays must be an integer from 1 to ${MAX_WINDOW_DAYS}`);
  }
  const from = dayNumber(input.from);
  const to = dayNumber(input.to);
  if (from >= to) throw new RangeError('--from must be earlier than --to');
  const today = dayNumber(input.today.toISOString().slice(0, 10));
  if (to > today) throw new RangeError('--to must not be later than today');
  const count = Math.ceil((to - from) / n);
  if (count > MAX_WINDOWS) throw new RangeError(`plan has ${count} windows (max ${MAX_WINDOWS})`);

  const out: BackfillWindow[] = [];
  for (let i = 0; i < count; i++) {
    const startN = from + i * n;
    const endN = Math.min(startN + n, to);
    const start = dayString(startN);
    const end = dayString(endN);
    const fromIso = `${start}T00:00:00.000Z`;
    const toIso = `${end}T00:00:00.000Z`;
    out.push({
      index: i,
      start,
      end,
      fromIso,
      toIso,
      day: end,
      runId: windowRunId(input.accountId, fromIso, toIso),
    });
  }
  return out;
}

/** Activity calls for a plan: windows x (1 + extra result pages per window). */
export function estimateCalls(windows: number, extraPagesPerWindow: number): number {
  return windows * (1 + extraPagesPerWindow);
}

export interface CallEstimate {
  windows: number;
  formula: 'windows x (1 + extraPagesPerWindow)';
  /** One call per window, no extra pages: the floor. */
  minCalls: number;
  /** Activities per Activity API page. */
  pageSize: number;
  /** Extra result pages per window are unknown until windows are fetched. */
  extraPagesPerWindow: string;
  /** Illustration only: [ASSUME] scenarios, not predictions. */
  scenarios: Array<{ extraPagesPerWindow: number; calls: number; label: '[ASSUME]' }>;
  /** The People API is never called by the backfill. */
  peopleApiCalls: 0;
}

export function callEstimate(windows: number): CallEstimate {
  return {
    windows,
    formula: 'windows x (1 + extraPagesPerWindow)',
    minCalls: estimateCalls(windows, 0),
    pageSize: ACTIVITY_PAGE_SIZE,
    extraPagesPerWindow: '[MEASURE: first confirmed windows; not knowable without fetching]',
    scenarios: [0, 1, 3].map((p) => ({
      extraPagesPerWindow: p,
      calls: estimateCalls(windows, p),
      label: '[ASSUME]' as const,
    })),
    peopleApiCalls: 0,
  };
}
