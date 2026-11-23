/**
 * Configuration of the casting Cloud Run Job (S9 task 6), read from the environment and
 * validated before anything runs. Pure: no config module, Prisma or model code.
 *
 * What the job does: `casting-run --incremental` for each configured account with the FREE
 * stages only (t1, t2, load, fusion). The paid T3 stage is impossible from the job unless BOTH
 * of these are set, and both default to off:
 *
 *   CASTING_T3_ENABLED=true            the enable flag
 *   CASTING_T3_DAILY_MAX_USD=<number>  the written budget for one execution of the job
 *
 * Setting them is the user's approval decision (a scheduled paid run is not covered by any
 * earlier single-use approval); this code never sets, defaults or infers either.
 *
 * Every variable is strict: `true` or `false` (or unset) for the flags, a number for the budget.
 * A typo is a refusal of the whole job (exit 2), never a silent fallback to a different mode.
 */

export const JOB_ENV = {
  /** Comma list of account uuids: the accounts the job covers. Empty = the job refuses (nothing is enabled). */
  accounts: 'CASTING_JOB_ACCOUNT_IDS',
  /** `true` = the free stages write. Default off: the job only plans (every stage a dry-run, nothing written). */
  apply: 'CASTING_JOB_APPLY',
  /** Sliding window length in years, 1..20. Default 5. */
  windowYears: 'CASTING_WINDOW_YEARS',
  /** Comma list of YYYY-MM-DD: roster placeholder start dates, passed as --unknown-start-date. */
  unknownStartDates: 'CASTING_UNKNOWN_START_DATES',
  /** The paid-stage enable flag. Default off. */
  t3Enabled: 'CASTING_T3_ENABLED',
  /** The paid-stage budget (USD) for one execution of the job, split evenly across the accounts. */
  t3DailyMaxUsd: 'CASTING_T3_DAILY_MAX_USD',
  /** Absolute, persistent base directory of the T3 ledgers: `<base>/<account>/<day>`. */
  t3LedgerDir: 'CASTING_T3_LEDGER_DIR',
} as const;

/** The stages the job runs without any paid-stage switch. Never contains `t3`. */
export const FREE_STAGES = ['t1', 't2', 'load', 'fusion'] as const;

export interface JobConfig {
  readonly accounts: readonly string[];
  readonly apply: boolean;
  readonly windowYears: number;
  readonly unknownStartDates: readonly string[];
  /** Null unless the enable flag AND a valid budget are both set. */
  readonly t3: { readonly dailyMaxUsd: number; readonly ledgerBase: string } | null;
  /** Non-fatal remarks (counts-only text) to log at start. */
  readonly notes: readonly string[];
}

export type JobConfigResult =
  | { readonly ok: true; readonly config: JobConfig }
  | { readonly ok: false; readonly reasons: readonly string[] };

type Env = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

function flag(env: Env, name: string, reasons: string[]): boolean {
  const v = env[name];
  if (!present(v) || v.trim() === 'false') return false;
  if (v.trim() === 'true') return true;
  reasons.push(`${name} must be "true" or "false" (or unset)`);
  return false;
}

export function parseJobEnv(env: Env): JobConfigResult {
  const reasons: string[] = [];
  const notes: string[] = [];

  const accounts = [
    ...new Set(
      (env[JOB_ENV.accounts] ?? '')
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a !== ''),
    ),
  ];
  if (accounts.length === 0) reasons.push(`${JOB_ENV.accounts} is empty: no account is enabled`);
  for (const a of accounts) {
    if (!UUID.test(a)) reasons.push(`${JOB_ENV.accounts} holds a value that is not a uuid`);
  }

  const apply = flag(env, JOB_ENV.apply, reasons);

  let windowYears = 5;
  if (present(env[JOB_ENV.windowYears])) {
    const n = Number(env[JOB_ENV.windowYears]);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      reasons.push(`${JOB_ENV.windowYears} must be an integer from 1 to 20`);
    } else windowYears = n;
  }

  const unknownStartDates = (env[JOB_ENV.unknownStartDates] ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '');
  for (const d of unknownStartDates) {
    if (!ISO.test(d) || Number.isNaN(Date.parse(d))) {
      reasons.push(`${JOB_ENV.unknownStartDates} must be YYYY-MM-DD dates`);
      break;
    }
  }

  // The paid stage: BOTH switches, else off. An enable flag without a budget is a refusal (the
  // intent is unclear and the safe reading is to run nothing); a budget alone leaves T3 off.
  const enabled = flag(env, JOB_ENV.t3Enabled, reasons);
  const budgetRaw = env[JOB_ENV.t3DailyMaxUsd];
  let budget: number | null = null;
  if (present(budgetRaw)) {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n) || !(n > 0))
      reasons.push(`${JOB_ENV.t3DailyMaxUsd} must be a number > 0`);
    else budget = n;
  }
  let t3: JobConfig['t3'] = null;
  if (enabled) {
    if (budget === null) {
      reasons.push(`${JOB_ENV.t3Enabled}=true needs ${JOB_ENV.t3DailyMaxUsd} (the written budget)`);
    }
    if (!apply) {
      reasons.push(`${JOB_ENV.t3Enabled}=true needs ${JOB_ENV.apply}=true`);
    }
    const dir = env[JOB_ENV.t3LedgerDir];
    if (!present(dir) || !dir.startsWith('/')) {
      reasons.push(
        `${JOB_ENV.t3Enabled}=true needs ${JOB_ENV.t3LedgerDir} (an absolute, persistent path)`,
      );
    }
    if (budget !== null && apply && present(dir) && dir.startsWith('/')) {
      t3 = { dailyMaxUsd: budget, ledgerBase: dir.replace(/\/+$/, '') };
    }
  } else if (budget !== null) {
    notes.push(
      `${JOB_ENV.t3DailyMaxUsd} is set but ${JOB_ENV.t3Enabled} is not true: the paid stage stays off`,
    );
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, config: { accounts, apply, windowYears, unknownStartDates, t3, notes } };
}

/** The `casting-run` argv of the free-stage pass for one account. Never contains `t3`. */
export function freeArgv(config: JobConfig, accountId: string): string[] {
  return [
    '--account-id',
    accountId,
    '--incremental',
    '--window-years',
    String(config.windowYears),
    '--stages',
    FREE_STAGES.join(','),
    ...config.unknownStartDates.flatMap((d) => ['--unknown-start-date', d]),
    ...(config.apply ? ['--apply'] : []),
  ];
}

/** `<base>/<account>/<YYYY-MM-DD>` (UTC day): the per-day ledger of one account. */
export const ledgerDirFor = (base: string, accountId: string, day: string): string =>
  `${base}/${accountId}/${day}`;

/** The T3 plan pass of one account: the whole delta, no write, no model. */
export function t3PlanArgv(config: JobConfig, accountId: string, ledgerDir: string): string[] {
  return [
    '--account-id',
    accountId,
    '--incremental',
    '--window-years',
    String(config.windowYears),
    '--stages',
    't3',
    '--ledger-dir',
    ledgerDir,
    ...config.unknownStartDates.flatMap((d) => ['--unknown-start-date', d]),
  ];
}

/**
 * The paid pass of one account, built only from a plan the job just read: the cell count and the
 * cap come from that plan and the budget, never from a default. `maxUsd` is this account's share.
 */
export function t3ApplyArgv(
  config: JobConfig,
  accountId: string,
  ledgerDir: string,
  plan: { readonly cells: number; readonly maxUsd: number },
): string[] {
  return [
    '--account-id',
    accountId,
    '--incremental',
    '--window-years',
    String(config.windowYears),
    '--apply',
    '--apply-t3',
    '--ledger-dir',
    ledgerDir,
    '--max-cells',
    String(Math.max(1, plan.cells)),
    '--max-usd',
    String(plan.maxUsd),
    '--expect-cells',
    String(plan.cells),
    ...config.unknownStartDates.flatMap((d) => ['--unknown-start-date', d]),
  ];
}
