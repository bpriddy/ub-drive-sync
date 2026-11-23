/**
 * The orchestrator core of `casting-run`. Hermetic: it imports no config, Prisma, logger, Drive or
 * model code. The stages arrive through `StageFns` (real-stages.ts in production, fakes in tests).
 *
 * Flow: build and validate every stage's argv (their own parsers) -> preflight guards -> lock and
 * audit log (paid run only) -> stages in the fixed order t1, t2, t3, load, fusion, stopping at the
 * first stage that is not ok -> one summary line.
 *
 * Exit codes are the stages' own table: 0 ok, 1 error, 2 refused (nothing of that stage started),
 * 3 plan printed (nothing written), 4 T3 stopped at the cost ceiling, 75 paused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FUSION_VERSION } from '../fusion/constants';
import { extractorVersionOf, GuardError, PILOT_HEADER_FILE } from '../t3/ledger';
import { PILOT_CAP_CHARS, type BeforeApplyInfo } from '../t3/pilot';
import { T3_PROMPT_VERSION } from '../t3/types';
import type { CastingArgs, StageName } from './args';
import {
  acquireLock,
  checkBeforeApply,
  checkLedgerOutside,
  checkModelEnv,
  checkModelPriced,
  findPaidTwice,
  fusionPinReminder,
  runLogPathOf,
} from './guards';
import { buildPlan, type StagePlan } from './plan';
import { makeEmitter, type LogRecord } from './runlog';

export const EXIT = { ok: 0, failed: 1, refused: 2, plan: 3, stopped: 4, paused: 75 } as const;

export interface StageFns {
  t1(argv: readonly string[]): Promise<number>;
  t2(argv: readonly string[]): Promise<number>;
  /**
   * The pilot driver (it also runs full waves). `beforeApply` is the orchestrator's guard hook;
   * `onProposal` (optional) observes the PROPOSAL in dry-run and apply.
   */
  t3(
    argv: readonly string[],
    hooks: {
      beforeApply(info: BeforeApplyInfo): void | Promise<void>;
      onProposal?(info: BeforeApplyInfo): void;
    },
  ): Promise<number>;
  load(argv: readonly string[]): Promise<number>;
  fusion(argv: readonly string[]): Promise<number>;
}

/** Answer of the change probe: did the file index of the account change since the last casting run? */
export interface ChangeProbeResult {
  readonly changed: boolean;
  /** `no_baseline`, `changed`, `no_change`, `probe_error`, `no_probe`: counts-only, safe to log. */
  readonly reason: string;
  readonly filesChanged: number | null;
}

export interface RunDeps {
  readonly stages: StageFns;
  /**
   * Incremental apply only: a read-only probe of the account's file index. Absent = assume a
   * change (the free stages are idempotent, so a missing probe costs a run, never correctness).
   */
  readonly changeProbe?: ((accountId: string) => Promise<ChangeProbeResult>) | undefined;
  /** Observes the T3 PROPOSAL (dry-run and apply); used by the job's plan step. */
  readonly onProposal?: ((info: BeforeApplyInfo) => void) | undefined;
  /** Receives every log line (stdout in production). */
  readonly out: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The checkout and the working directory: a ledger inside either is refused. */
  readonly repoRoots: readonly string[];
  readonly now: () => Date;
  /** Called once, before any stage, with the merged agency e-mail domain list (comma separated). */
  readonly applyAgencyDomains: (csv: string) => void;
  readonly isPidAlive?: ((pid: number) => boolean) | undefined;
}

export type StageStatus = 'ok' | 'failed' | 'skipped' | 'not_run';

export interface StageResult {
  readonly stage: StageName;
  readonly status: StageStatus;
  readonly exitCode: number | null;
}

export interface RunOutcome {
  readonly exitCode: number;
  /** The stage (or `preflight`) whose result decided the exit code; null on a clean finish. */
  readonly decidedBy: StageName | 'preflight' | null;
  readonly results: readonly StageResult[];
}

const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0]?.slice(0, 200) ?? '';

function modeOf(args: CastingArgs): 'plan' | 'apply' | 'apply-t3' {
  return args.applyT3 ? 'apply-t3' : args.apply ? 'apply' : 'plan';
}

/** A stage code that is not ok maps to the orchestrator code that halts the chain. */
function haltCode(code: number): number {
  return code === EXIT.refused || code === EXIT.stopped || code === EXIT.paused
    ? code
    : EXIT.failed;
}

const isOk = (code: number, sp: StagePlan): boolean =>
  code === EXIT.ok || (code === EXIT.plan && !sp.apply);

function runStage(
  sp: StagePlan,
  args: CastingArgs,
  stages: StageFns,
  onProposal: ((info: BeforeApplyInfo) => void) | undefined,
): Promise<number> {
  switch (sp.stage) {
    case 't1':
      return stages.t1(sp.argv);
    case 't2':
      return stages.t2(sp.argv);
    case 't3': {
      // Only invoked by the pilot in apply, after its own guards; both limits exist then.
      const limits = { expectCells: args.expectCells ?? -1, maxUsd: args.maxUsd ?? 0 };
      return stages.t3(sp.argv, {
        beforeApply: (info) => {
          checkBeforeApply(info, limits);
          if (args.incremental && !args.allowRepeatPaid && sp.pilotArgs && info.cellKeys) {
            // The same paid-twice detector, by cell: a daily ledger has the same configuration as
            // yesterday's by design, so only a sibling that already paid one of THESE cells is a twin.
            const twin = findPaidTwice(args.ledgerDir as string, sp.pilotArgs, {
              overlapWith: new Set(info.cellKeys),
            });
            if (twin !== null) {
              throw new GuardError(
                `another ledger directory (${twin}) already paid for at least one of these cells; use --allow-repeat-paid to pay again; nothing was started`,
              );
            }
          }
        },
        ...(onProposal ? { onProposal } : {}),
      });
    }
    case 'load':
      return stages.load(sp.argv);
    case 'fusion':
      return stages.fusion(sp.argv);
  }
}

export async function runCasting(args: CastingArgs, deps: RunDeps): Promise<RunOutcome> {
  const mode = modeOf(args);
  let emit = makeEmitter(deps.out, null);
  const refuse = (message: string, decidedBy: 'preflight'): RunOutcome => {
    emit({ msg: 'casting-run refused', mode, reason: message });
    const outcome: RunOutcome = { exitCode: EXIT.refused, decidedBy, results: [] };
    emit({ msg: 'casting-run summary', mode, exitCode: outcome.exitCode, decidedBy, stages: [] });
    return outcome;
  };

  // 1. Build and validate every stage's argv with the stages' own parsers.
  let plan;
  try {
    plan = buildPlan(args, deps.env['CASTING_AGENCY_EMAIL_DOMAINS']);
  } catch (err) {
    return refuse(firstLine(err), 'preflight');
  }

  // 2. Preflight guards, before any stage starts.
  const t3 = plan.stages.find((s) => s.stage === 't3');
  let release: (() => void) | null = null;
  try {
    if (args.applyT3 && t3?.pilotArgs) {
      checkModelEnv(deps.env);
      checkModelPriced(t3.pilotArgs.model);
      checkLedgerOutside(args.ledgerDir as string, deps.repoRoots);
      // Incremental runs check the twin by cell at apply time (the PROPOSAL knows the cells).
      const twin =
        args.allowRepeatPaid || args.incremental
          ? null
          : findPaidTwice(args.ledgerDir as string, t3.pilotArgs);
      if (twin !== null) {
        throw new GuardError(
          `another ledger directory (${twin}) already paid for this account and configuration; use --allow-repeat-paid to pay again; nothing was started`,
        );
      }
    }
    const load = plan.stages.find((s) => s.stage === 'load');
    if (
      load &&
      load.skipReason === null &&
      load.apply &&
      !args.applyT3 &&
      !args.incremental &&
      args.ledgerDir !== null
    ) {
      if (!fs.existsSync(path.join(args.ledgerDir, PILOT_HEADER_FILE))) {
        throw new GuardError(
          'the load stage has no ledger (no header.json in --ledger-dir); nothing was started',
        );
      }
    }
    // 3. Lock and audit log for the paid run; both sit next to the ledger directory.
    if (args.applyT3) {
      release = acquireLock(args.ledgerDir as string, deps.now(), deps.isPidAlive);
      emit = makeEmitter(deps.out, runLogPathOf(args.ledgerDir as string));
    }
  } catch (err) {
    return refuse(firstLine(err), 'preflight');
  }

  const results: StageResult[] = plan.stages.map((s) => ({
    stage: s.stage,
    status: 'not_run',
    exitCode: null,
  }));
  let exitCode: number = EXIT.ok;
  let decidedBy: StageName | null = null;
  try {
    const pinNote = fusionPinReminder(deps.env);
    const t3Args = t3?.pilotArgs ?? null;
    const planRec: LogRecord = {
      msg: 'casting-run plan',
      mode,
      windowStart: args.windowStart,
      // The window cutoff of this run (S9 task 5). A slide moves only what is selected from
      // now on; it deletes no evidence (docs/casting-pipeline.md, "Sliding window").
      windowCutoff: args.windowStart,
      windowYears: args.windowYears,
      incremental: args.incremental,
      stages: plan.stages.map((s) => ({
        stage: s.stage,
        mode: s.apply ? 'apply' : 'dry-run',
        skip: s.skipReason,
      })),
      fusionVersion: FUSION_VERSION,
      ...(t3Args
        ? {
            t3ExtractorVersion: extractorVersionOf({
              promptVersion: T3_PROMPT_VERSION,
              model: t3Args.model,
              thinkingLevel: t3Args.thinkingLevel,
              capChars: PILOT_CAP_CHARS,
            }),
          }
        : {}),
      ...(pinNote ? { warning: pinNote } : {}),
    };
    emit(planRec);
    deps.applyAgencyDomains(plan.agencyDomains.join(','));

    // Incremental apply: ask the file index whether anything changed since the last casting run.
    // A quiet account skips the free stages (they would only open run rows and rebuild Layer 2
    // to the same content); the paid stage is never gated by this probe, its own delta decides.
    let quiet = false;
    if (args.incremental && args.apply) {
      let probe: ChangeProbeResult;
      try {
        probe = deps.changeProbe
          ? await deps.changeProbe(args.accountId)
          : { changed: true, reason: 'no_probe', filesChanged: null };
      } catch (err) {
        probe = { changed: true, reason: 'probe_error', filesChanged: null };
        emit({ msg: 'casting-run change probe failed', error: firstLine(err) });
      }
      quiet = !probe.changed;
      emit({
        msg: 'casting-run change probe',
        changed: probe.changed,
        reason: probe.reason,
        filesChanged: probe.filesChanged,
      });
    }
    // Set once a stage of this run produced something downstream stages must pick up.
    let newLedger = false;

    let wrote = false;
    for (let i = 0; i < plan.stages.length; i++) {
      const sp = plan.stages[i] as StagePlan;
      const quietSkip =
        quiet && (sp.stage === 't1' || sp.stage === 't2' || (sp.stage === 'fusion' && !newLedger));
      const skip =
        sp.skipReason ??
        (quietSkip ? 'no change in the file index since the last casting run' : null) ??
        (sp.needsLedger && !fs.existsSync(path.join(args.ledgerDir as string, PILOT_HEADER_FILE))
          ? 'no ledger yet: nothing to load'
          : null);
      if (skip !== null) {
        results[i] = { stage: sp.stage, status: 'skipped', exitCode: null };
        emit({ msg: 'casting-run stage skipped', stage: sp.stage, reason: skip });
        continue;
      }
      const started = deps.now();
      emit({
        msg: 'casting-run stage start',
        stage: sp.stage,
        mode: sp.apply ? 'apply' : 'dry-run',
      });
      let code: number;
      let error: string | null = null;
      try {
        code = await runStage(sp, args, deps.stages, deps.onProposal);
      } catch (err) {
        code = err instanceof GuardError ? EXIT.refused : EXIT.failed;
        error = firstLine(err);
      }
      emit({
        msg: 'casting-run stage end',
        stage: sp.stage,
        mode: sp.apply ? 'apply' : 'dry-run',
        exitCode: code,
        durationMs: deps.now().getTime() - started.getTime(),
        ...(error !== null ? { error } : {}),
      });
      if (sp.apply) wrote = true;
      if (
        sp.stage === 't3' &&
        sp.apply &&
        code === EXIT.ok &&
        args.incremental &&
        args.ledgerDir !== null &&
        fs.existsSync(path.join(args.ledgerDir, PILOT_HEADER_FILE))
      ) {
        newLedger = true;
      }
      if (isOk(code, sp)) {
        results[i] = { stage: sp.stage, status: 'ok', exitCode: code };
        continue;
      }
      results[i] = { stage: sp.stage, status: 'failed', exitCode: code };
      exitCode = haltCode(code);
      decidedBy = sp.stage;
      break;
    }
    // A quiet incremental apply is a clean finish (exit 0), not a "plan printed": a scheduled job
    // must not look failed on a day with nothing to do.
    if (decidedBy === null)
      exitCode = wrote || (args.incremental && args.apply) ? EXIT.ok : EXIT.plan;
  } finally {
    if (release) release();
  }

  emit({
    msg: 'casting-run summary',
    mode,
    exitCode,
    decidedBy,
    windowCutoff: args.windowStart,
    stages: results,
  });
  return { exitCode, decidedBy, results };
}
