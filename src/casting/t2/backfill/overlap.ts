/**
 * Overlap protection (a HARD ERROR, never a warning).
 *
 * The double-counting mechanism: `drive_edit_stats` is keyed by
 * (sync_run_id, file_id, actor_email) and every reader sums rows across runs
 * (the panel GROUPs by actor and day). The existing `seed-edit-stats` gives every
 * 30-day window a RANDOM run id, so seeding a second time over windows that
 * overlap an earlier seed (or a forward run) does not replace anything: it adds
 * a second copy of the same events, and every counter doubles. Nothing in the
 * table records which time range a run covered.
 *
 * The check: every existing run id of the account is read through an injected
 * reader. A run covers (minDay - span, maxDay] (its rows are dated by the window
 * END, and `span` is the longest window it can have, 30 days by default, which
 * is the existing seed's window and the cap of this command). A planned window
 * (start, end] that intersects the coverage of any existing run is refused. The
 * only exemptions are runs whose id is one of the plan's own deterministic ids:
 * those are replaced by a retry. As a consequence `--to` must not be later than
 * the start of the earliest existing seed window (earliest existing day minus
 * span). A boundary gap of less than one day can remain uncovered at that
 * edge (the old windows start at a time of day, the new ones at 00:00:00Z):
 * that undercounts, it never double-counts.
 */
import { dayNumber, dayString } from './windows';
import { type BackfillWindow, type ExistingRun, MAX_WINDOW_DAYS } from './types';

export class OverlapError extends Error {
  constructor(
    message: string,
    readonly detail: OverlapCheck,
  ) {
    super(message);
    this.name = 'OverlapError';
  }
}

export interface OverlapCheck {
  /** Existing runs other than the plan's own ids. */
  foreignRuns: number;
  /** Runs of the plan's own ids already present (a retry or a resume replaces them). */
  ownRunsPresent: number;
  /** Earliest day of a foreign run, or null. */
  earliestForeignDay: string | null;
  /** The latest `--to` that cannot overlap (earliest foreign day minus span), or null when none. */
  latestAllowedTo: string | null;
  /** Indexes of refused windows (capped list), and the total. */
  conflictingWindows: number[];
  conflictCount: number;
  spanDays: number;
}

const MAX_LISTED = 20;

export function checkOverlap(
  windows: readonly BackfillWindow[],
  existing: readonly ExistingRun[],
  spanDays: number = MAX_WINDOW_DAYS,
): OverlapCheck {
  if (!Number.isInteger(spanDays) || spanDays < 1 || spanDays > MAX_WINDOW_DAYS) {
    throw new RangeError(`existing window span must be an integer from 1 to ${MAX_WINDOW_DAYS}`);
  }
  const own = new Set(windows.map((w) => w.runId));
  const foreign = existing.filter((r) => !own.has(r.syncRunId));
  const ownRunsPresent = existing.length - foreign.length;

  const coverage = foreign.map((r) => ({
    start: dayNumber(r.minDay) - spanDays,
    end: dayNumber(r.maxDay),
  }));
  const conflicting: number[] = [];
  let conflictCount = 0;
  for (const w of windows) {
    const s = dayNumber(w.start);
    const e = dayNumber(w.end);
    // Half-open ranges (s, e] and (a, b] intersect iff s < b and a < e.
    if (coverage.some((c) => s < c.end && c.start < e)) {
      conflictCount += 1;
      if (conflicting.length < MAX_LISTED) conflicting.push(w.index);
    }
  }
  const earliest =
    foreign.length === 0 ? null : Math.min(...foreign.map((r) => dayNumber(r.minDay)));
  const result: OverlapCheck = {
    foreignRuns: foreign.length,
    ownRunsPresent,
    earliestForeignDay: earliest === null ? null : dayString(earliest),
    latestAllowedTo: earliest === null ? null : dayString(earliest - spanDays),
    conflictingWindows: conflicting,
    conflictCount,
    spanDays,
  };
  if (conflictCount > 0) {
    throw new OverlapError(
      `refused: ${conflictCount} of ${windows.length} windows overlap existing edit-stats runs ` +
        `(double-counting). --to must not be later than ${result.latestAllowedTo} ` +
        `(earliest existing day ${result.earliestForeignDay} minus ${spanDays} days)`,
      result,
    );
  }
  return result;
}
