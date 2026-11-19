/**
 * Strict argument parsing for the T2 stage. Unknown flags and flags missing a
 * value are errors: a typo must never turn into a run on the wrong scope.
 *
 *   --account-id <uuid>          repeatable, at least one (no implicit "all accounts")
 *   --apply                      write evidence (default: dry-run, nothing written)
 *   --resume-run-id <uuid>       continue a paused or failed apply run (needs --apply)
 *   --chunk-size <n>             stats groups per page (default 2000)
 *   --window-start <date|none>   5-year window start, YYYY-MM-DD (default: today minus 5 years)
 *   --budget-seconds <n>         stop at the next page boundary after n seconds; resumable
 *   --agency-domain <domain>     repeatable; also CASTING_AGENCY_EMAIL_DOMAINS (comma list)
 *   --unknown-start-date <date>  repeatable; a staff.started_at value that is an import
 *                                placeholder, not a real start (window gate off for it)
 */
export interface T2Args {
  accountIds: string[];
  apply: boolean;
  resumeRunId: string | null;
  chunkSize: number | null;
  /** undefined = default (today minus 5 years), null = no window. */
  windowStart: string | null | undefined;
  budgetSeconds: number | null;
  agencyDomains: string[];
  unknownStartDates: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (v: string): boolean => ISO.test(v) && !Number.isNaN(Date.parse(v));

const KNOWN = [
  '--account-id',
  '--resume-run-id',
  '--chunk-size',
  '--window-start',
  '--budget-seconds',
  '--agency-domain',
  '--unknown-start-date',
];

export function parseT2Args(args: readonly string[]): T2Args {
  const out: T2Args = {
    accountIds: [],
    apply: false,
    resumeRunId: null,
    chunkSize: null,
    windowStart: undefined,
    budgetSeconds: null,
    agencyDomains: [],
    unknownStartDates: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--apply') {
      out.apply = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!KNOWN.includes(flag)) throw new Error(`casting-t2: unknown argument ${arg}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`casting-t2: ${flag} needs a value`);

    switch (flag) {
      case '--account-id':
        if (!UUID.test(value)) throw new Error('casting-t2: --account-id must be a uuid');
        if (!out.accountIds.includes(value)) out.accountIds.push(value);
        break;
      case '--resume-run-id':
        if (!UUID.test(value)) throw new Error('casting-t2: --resume-run-id must be a uuid');
        out.resumeRunId = value;
        break;
      case '--chunk-size': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 20_000) {
          throw new Error('casting-t2: --chunk-size must be an integer from 1 to 20000');
        }
        out.chunkSize = n;
        break;
      }
      case '--window-start':
        if (value === 'none') out.windowStart = null;
        else if (isIsoDate(value)) out.windowStart = value;
        else throw new Error('casting-t2: --window-start must be YYYY-MM-DD or none');
        break;
      case '--budget-seconds': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0)
          throw new Error('casting-t2: --budget-seconds must be positive');
        out.budgetSeconds = n;
        break;
      }
      case '--agency-domain':
        out.agencyDomains.push(value.toLowerCase());
        break;
      case '--unknown-start-date':
        if (!isIsoDate(value))
          throw new Error('casting-t2: --unknown-start-date must be YYYY-MM-DD');
        if (!out.unknownStartDates.includes(value)) out.unknownStartDates.push(value);
        break;
    }
  }
  if (out.accountIds.length === 0)
    throw new Error('casting-t2: at least one --account-id is required');
  if (out.resumeRunId !== null && !out.apply)
    throw new Error('casting-t2: --resume-run-id needs --apply');
  return out;
}
