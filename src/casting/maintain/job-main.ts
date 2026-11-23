/**
 * Entry of the casting Cloud Run Job (S9 task 6): `casting-run --incremental` for the configured
 * accounts, FREE stages only, unless the paid stage is switched on by two explicit variables.
 *
 *   node dist/src/casting/maintain/job-main.js          (configuration comes from the environment)
 *
 * Same image as the drive-sync job, a different command (the image ENTRYPOINT is overridden by
 * the job definition). This file creates no scheduler, no job and no deploy step: how to create
 * and schedule the job is described in docs/casting-pipeline.md and needs the user's go.
 *
 * Per account (sequentially, one failing account never hides another):
 *   1. free pass:  casting-run --incremental --stages t1,t2,load,fusion [--apply]
 *   2. only when CASTING_T3_ENABLED=true AND CASTING_T3_DAILY_MAX_USD is set (see job-config.ts):
 *      a PLAN of the account's T3 delta (read-only), then, if it has cells and its base estimate
 *      fits this account's share of the budget, ONE paid pass whose `--expect-cells` and
 *      `--max-cells` are that plan's cell count and whose `--max-usd` is the account's share.
 *      Every guard of casting-run still applies (model preflight, ledger outside the repo, lock,
 *      paid-twice by cell, expect-cells, cap above the base estimate).
 *
 * Exit code: 0 when every account finished (a plan-only run counts as finished), else the
 * highest-priority failure: 1 error, 2 refused, 4 stopped at the cost ceiling, 75 paused.
 * Logging: counts-only JSON lines on stdout.
 */
import {
  parseJobEnv,
  freeArgv,
  ledgerDirFor,
  t3ApplyArgv,
  t3PlanArgv,
  type JobConfig,
} from './job-config';
import type { BeforeApplyInfo } from '../t3/pilot';

export interface JobIo {
  /** One `casting-run` invocation (the real one parses and runs it). `onProposal` observes the T3 PROPOSAL. */
  casting(argv: readonly string[], onProposal?: (info: BeforeApplyInfo) => void): Promise<number>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly out: (line: string) => void;
}

const EXIT = { ok: 0, failed: 1, refused: 2, plan: 3, stopped: 4, paused: 75 } as const;
/** Failure codes, most serious first. */
const PRIORITY = [EXIT.failed, EXIT.refused, EXIT.stopped, EXIT.paused] as const;

const day = (d: Date): string => d.toISOString().slice(0, 10);
/** Money in whole cents, rounded down: a share never adds up to more than the budget. */
const floorCents = (n: number): number => Math.floor(n * 100) / 100;

export async function runJob(io: JobIo): Promise<number> {
  const emit = (rec: Record<string, unknown>): void => io.out(JSON.stringify(rec));
  const parsed = parseJobEnv(io.env);
  if (!parsed.ok) {
    emit({ msg: 'casting-job refused', reasons: parsed.reasons });
    return EXIT.refused;
  }
  const config = parsed.config;
  emit({
    msg: 'casting-job start',
    accounts: config.accounts.length,
    apply: config.apply,
    windowYears: config.windowYears,
    paidStage: config.t3 !== null,
    ...(config.t3 ? { dailyMaxUsd: config.t3.dailyMaxUsd } : {}),
    ...(config.notes.length > 0 ? { notes: config.notes } : {}),
  });

  const failures = new Set<number>();
  const note = (code: number): void => {
    // A plan (exit 3) is a clean finish for the job: it is what a job with writes off does.
    if (code !== EXIT.ok && code !== EXIT.plan) failures.add(code);
  };
  const share = config.t3 ? floorCents(config.t3.dailyMaxUsd / config.accounts.length) : 0;
  const today = day(io.now());

  for (const accountIndex of config.accounts.keys()) {
    const accountId = config.accounts[accountIndex] as string;
    const label = { account: accountIndex + 1, of: config.accounts.length };

    // Paid pass first in the chain (it includes the free stages around it) or the free pass alone.
    const paid = config.t3
      ? await planPaid(io, config, accountId, today, share, emit, label)
      : null;
    if (paid !== null) {
      const code = await io.casting(paid);
      emit({ msg: 'casting-job account done', ...label, pass: 'paid', exitCode: code });
      note(code);
      continue;
    }
    const code = await io.casting(freeArgv(config, accountId));
    emit({ msg: 'casting-job account done', ...label, pass: 'free', exitCode: code });
    note(code);
  }

  const exitCode = PRIORITY.find((c) => failures.has(c)) ?? EXIT.ok;
  emit({ msg: 'casting-job summary', exitCode, failedAccounts: failures.size > 0 });
  return exitCode;
}

/**
 * The T3 plan step. Returns the argv of the paid pass, or null when the account runs the free
 * pass alone (nothing to pay, an estimate above the account's share, or the plan failed).
 */
async function planPaid(
  io: JobIo,
  config: JobConfig,
  accountId: string,
  today: string,
  share: number,
  emit: (rec: Record<string, unknown>) => void,
  label: Record<string, number>,
): Promise<string[] | null> {
  const t3 = config.t3 as NonNullable<JobConfig['t3']>;
  const dir = ledgerDirFor(t3.ledgerBase, accountId, today);
  let info: BeforeApplyInfo | null = null;
  const code = await io.casting(t3PlanArgv(config, accountId, dir), (i) => {
    info = i;
  });
  const seen = info as BeforeApplyInfo | null;
  if (seen === null || (code !== EXIT.plan && code !== EXIT.ok)) {
    emit({ msg: 'casting-job t3 plan unavailable', ...label, exitCode: code });
    return null;
  }
  if (seen.cells === 0) {
    emit({
      msg: 'casting-job t3 plan',
      ...label,
      cells: 0,
      costUsd: 0,
      decision: 'nothing to pay',
    });
    return null;
  }
  if (seen.baseCostUsd === null || !seen.baseComplete || seen.baseCostUsd > share) {
    emit({
      msg: 'casting-job t3 plan',
      ...label,
      cells: seen.cells,
      baseCostUsd: seen.baseCostUsd,
      shareUsd: share,
      decision: 'not run: no complete estimate within this account share of the budget',
    });
    return null;
  }
  emit({
    msg: 'casting-job t3 plan',
    ...label,
    cells: seen.cells,
    baseCostUsd: seen.baseCostUsd,
    shareUsd: share,
    decision: 'run',
  });
  return t3ApplyArgv(config, accountId, dir, { cells: seen.cells, maxUsd: share });
}

export async function main(): Promise<number> {
  const { realDeps, runCastingCli } = await import('../run-all/main');
  return runJob({
    casting: (argv, onProposal) =>
      runCastingCli(argv, { ...realDeps(), ...(onProposal ? { onProposal } : {}) }),
    env: process.env,
    now: () => new Date(),
    out: (l) => console.log(l),
  });
}

if (require.main === module) {
  main()
    .then(async (code) => {
      try {
        await (await import('../t3/real-pilot-io')).closeRealIo();
      } catch {
        // nothing was connected
      }
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(EXIT.failed);
    });
}
