/**
 * Strict argument parsing for the edit-stats backfill. Unknown flags and flags
 * missing a value are errors.
 *
 *   --account-id <uuid>          exactly one
 *   --from <YYYY-MM-DD>          exclusive start of the first window (00:00:00Z)
 *   --to <YYYY-MM-DD>            end of the last window; not later than today and
 *                                not later than the start of the earliest existing
 *                                seed window (checked against the database)
 *   --window-days <n>            1..30, default 30 (7 gives tighter dates, more calls)
 *   --confirm                    fetch Activity and write (default: dry-run)
 *   --resume-run-id <uuid>       continue a paused or failed confirmed run (needs --confirm)
 *   --budget-seconds <n>         stop after the window that crosses n seconds; exit 75
 *   --max-calls <n>              stop after the window that reaches n Activity calls; exit 75
 *   --existing-window-days <n>   longest window an existing run can have (default 30)
 */
import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS } from './types';

export interface BackfillArgs {
  accountId: string;
  from: string;
  to: string;
  windowDays: number;
  confirm: boolean;
  resumeRunId: string | null;
  budgetSeconds: number | null;
  maxCalls: number | null;
  existingWindowDays: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (v: string): boolean =>
  ISO.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const KNOWN = [
  '--account-id',
  '--from',
  '--to',
  '--window-days',
  '--resume-run-id',
  '--budget-seconds',
  '--max-calls',
  '--existing-window-days',
];

export function parseBackfillArgs(args: readonly string[]): BackfillArgs {
  let accountId: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  const out = {
    windowDays: DEFAULT_WINDOW_DAYS,
    confirm: false,
    resumeRunId: null as string | null,
    budgetSeconds: null as number | null,
    maxCalls: null as number | null,
    existingWindowDays: null as number | null,
  };
  const windowInt = (flag: string, value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) {
      throw new Error(
        `casting-t2-backfill: ${flag} must be an integer from 1 to ${MAX_WINDOW_DAYS}`,
      );
    }
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--confirm') {
      out.confirm = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!KNOWN.includes(flag)) throw new Error(`casting-t2-backfill: unknown argument ${arg}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) {
      throw new Error(`casting-t2-backfill: ${flag} needs a value`);
    }
    switch (flag) {
      case '--account-id':
        if (accountId !== null) throw new Error('casting-t2-backfill: exactly one --account-id');
        if (!UUID.test(value)) throw new Error('casting-t2-backfill: --account-id must be a uuid');
        accountId = value;
        break;
      case '--from':
        if (!isIsoDate(value)) throw new Error('casting-t2-backfill: --from must be YYYY-MM-DD');
        from = value;
        break;
      case '--to':
        if (!isIsoDate(value)) throw new Error('casting-t2-backfill: --to must be YYYY-MM-DD');
        to = value;
        break;
      case '--window-days':
        out.windowDays = windowInt(flag, value);
        break;
      case '--existing-window-days':
        out.existingWindowDays = windowInt(flag, value);
        break;
      case '--resume-run-id':
        if (!UUID.test(value))
          throw new Error('casting-t2-backfill: --resume-run-id must be a uuid');
        out.resumeRunId = value;
        break;
      case '--budget-seconds': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error('casting-t2-backfill: --budget-seconds must be positive');
        }
        out.budgetSeconds = n;
        break;
      }
      case '--max-calls': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error('casting-t2-backfill: --max-calls must be a positive integer');
        }
        out.maxCalls = n;
        break;
      }
    }
  }
  if (accountId === null) throw new Error('casting-t2-backfill: --account-id is required');
  if (from === null) throw new Error('casting-t2-backfill: --from is required');
  if (to === null) throw new Error('casting-t2-backfill: --to is required');
  if (from >= to) throw new Error('casting-t2-backfill: --from must be earlier than --to');
  if (out.resumeRunId !== null && !out.confirm) {
    throw new Error('casting-t2-backfill: --resume-run-id needs --confirm');
  }
  return { accountId, from, to, ...out };
}
