/**
 * The ONLY file of the backfill that reaches the real Drive Activity client and
 * the real stats writer. Both are loaded lazily, inside the call, so importing
 * this module (or the stage's public surface) never constructs a client, and a
 * dry-run, which never calls these functions, never touches Drive.
 *
 * Reuses the existing forward code: `queryActivityWindow` and `foldEvents`
 * (src/forward/activity.ts) and `writeRunEditStats` (src/forward/stats.ts, which
 * replaces all rows of a run id in one transaction). Nothing there is edited.
 */
import { ACTIVITY_PAGE_SIZE, type ActivitySource, type EditStatsWriter } from './types';

export function createRealActivitySource(): ActivitySource {
  return {
    async foldWindow(rootFolderId, fromIso, toIso) {
      const { queryActivityWindow, foldEvents } = await import('../../../forward/activity');
      const events = await queryActivityWindow(rootFolderId, fromIso, toIso);
      const folded = foldEvents(events);
      return {
        tallies: folded.editTallies,
        events: events.length,
        // The client pages internally and does not report pages. One call per
        // 500 normalised events, at least one, is a proxy for the call budget:
        // a query returns activities, each of which can yield several events.
        calls: Math.max(1, Math.ceil(events.length / ACTIVITY_PAGE_SIZE)),
      };
    },
  };
}

export function createRealStatsWriter(): EditStatsWriter {
  return {
    async replaceWindow(args) {
      const { writeRunEditStats } = await import('../../../forward/stats');
      return writeRunEditStats(args);
    },
  };
}
