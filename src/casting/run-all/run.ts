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
  /** The pilot driver (it also runs full waves). `beforeApply` is the orchestrator's guard hook. */
  t3(
    argv: readonly string[],
    hooks: { beforeApply(info: BeforeApplyInfo): void | Promise<void> },
  ): Promise<number>;
  load(argv: readonly string[]): Promise<number>;
  fusion(argv: readonly string[]): Promise<number>;
}

export interface RunDeps {
  readonly stages: StageFns;
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

function runStage(sp: StagePlan, args: CastingArgs, stages: StageFns): Promise<number> {
  switch (sp.stage) {
    case 't1':
      return stages.t1(sp.argv);
    case 't2':
      return stages.t2(sp.argv);
    case 't3': {
      // Only invoked by the pilot in apply, after its own guards; both limits exist then.
      const limits = { expectCells: args.expectCells ?? -1, maxUsd: args.maxUsd ?? 0 };
      return stages.t3(sp.argv, {
        beforeApply: (info) => checkBeforeApply(info, limits),
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
      const twin = args.allowRepeatPaid
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

    let wrote = false;
    for (let i = 0; i < plan.stages.length; i++) {
      const sp = plan.stages[i] as StagePlan;
      const skip =
        sp.skipReason ??
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
        code = await runStage(sp, args, deps.stages);
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
      if (isOk(code, sp)) {
        results[i] = { stage: sp.stage, status: 'ok', exitCode: code };
        continue;
      }
      results[i] = { stage: sp.stage, status: 'failed', exitCode: code };
      exitCode = haltCode(code);
      decidedBy = sp.stage;
      break;
    }
    if (decidedBy === null) exitCode = wrote ? EXIT.ok : EXIT.plan;
  } finally {
    if (release) release();
  }

  emit({
    msg: 'casting-run summary',
    mode,
    exitCode,
    decidedBy,
    stages: results,
  });
  return { exitCode, decidedBy, results };
}
