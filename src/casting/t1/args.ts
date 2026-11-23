/**
 * Strict argument parsing for the T1 stage. Unknown flags and flags missing a
 * value are errors: a typo must never turn into a run on the wrong scope.
 *
 *   --account-id <uuid>        repeatable, at least one (no implicit "all accounts")
 *   --apply                    write evidence (default: dry-run, nothing written)
 *   --resume-run-id <uuid>     continue a paused or failed apply run (needs --apply)
 *   --chunk-size <n>           index rows per page (default 2000)
 *   --window-start <date|none> 5-year window start, YYYY-MM-DD (default: today minus 5 years)
 *   --budget-seconds <n>       stop at the next page boundary after n seconds; resumable
 *   --agency-domain <domain>   repeatable; also CASTING_AGENCY_EMAIL_DOMAINS (comma list)
 *   --known-prefix <LETTERS>   repeatable; extra strict job-code prefix for the unbracketed shape
 */
export interface T1Args {
  accountIds: string[];
  apply: boolean;
  resumeRunId: string | null;
  chunkSize: number | null;
  /** undefined = default (today minus 5 years), null = no window. */
  windowStart: string | null | undefined;
  budgetSeconds: number | null;
  agencyDomains: string[];
  knownPrefixes: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseT1Args(args: readonly string[]): T1Args {
  const out: T1Args = {
    accountIds: [],
    apply: false,
    resumeRunId: null,
    chunkSize: null,
    windowStart: undefined,
    budgetSeconds: null,
    agencyDomains: [],
    knownPrefixes: [],
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
    const known = [
      '--account-id',
      '--resume-run-id',
      '--chunk-size',
      '--window-start',
      '--budget-seconds',
      '--agency-domain',
      '--known-prefix',
    ];
    if (!known.includes(flag)) throw new Error(`casting-t1: unknown argument ${arg}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`casting-t1: ${flag} needs a value`);

    switch (flag) {
      case '--account-id':
        if (!UUID.test(value)) throw new Error('casting-t1: --account-id must be a uuid');
        if (!out.accountIds.includes(value)) out.accountIds.push(value);
        break;
      case '--resume-run-id':
        if (!UUID.test(value)) throw new Error('casting-t1: --resume-run-id must be a uuid');
        out.resumeRunId = value;
        break;
      case '--chunk-size': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 20_000) {
          throw new Error('casting-t1: --chunk-size must be an integer from 1 to 20000');
        }
        out.chunkSize = n;
        break;
      }
      case '--window-start':
        if (value === 'none') out.windowStart = null;
        else if (ISO.test(value) && !Number.isNaN(Date.parse(value))) out.windowStart = value;
        else throw new Error('casting-t1: --window-start must be YYYY-MM-DD or none');
        break;
      case '--budget-seconds': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0)
          throw new Error('casting-t1: --budget-seconds must be positive');
        out.budgetSeconds = n;
        break;
      }
      case '--agency-domain':
        out.agencyDomains.push(value.toLowerCase());
        break;
      case '--known-prefix':
        if (!/^[A-Z]{2,10}$/.test(value))
          throw new Error('casting-t1: --known-prefix must be 2-10 capital letters');
        out.knownPrefixes.push(value);
        break;
    }
  }
  if (out.accountIds.length === 0)
    throw new Error('casting-t1: at least one --account-id is required');
  if (out.resumeRunId !== null && !out.apply)
    throw new Error('casting-t1: --resume-run-id needs --apply');
  return out;
}

/** Five years before `today`, as YYYY-MM-DD (the sliding window start). */
export function defaultWindowStart(today: Date): string {
  const d = new Date(Date.UTC(today.getUTCFullYear() - 5, today.getUTCMonth(), today.getUTCDate()));
  return d.toISOString().slice(0, 10);
}
