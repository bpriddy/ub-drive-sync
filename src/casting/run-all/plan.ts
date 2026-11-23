/**
 * One flag set to the argv of every stage. The argv is validated with each stage's OWN parser
 * before anything runs, so a typo in the T3 flags is found before T1 writes a row. Pure: no
 * config, Prisma, logger or model code.
 */
import { parseFusionArgs } from '../fusion/args';
import { parseT1Args } from '../t1/args';
import { parseT2Args } from '../t2/args';
import { parseLoadArgs } from '../t3/load-args';
import { parsePilotArgs, type PilotArgs } from '../t3/pilot-args';
import type { CastingArgs, StageName } from './args';

export interface StagePlan {
  readonly stage: StageName;
  /** True when this stage writes (t3: calls the model). */
  readonly apply: boolean;
  readonly argv: readonly string[];
  /** Set when the stage cannot run at all in this invocation (the reason is logged). */
  readonly skipReason: string | null;
  /** t3 only: the pilot arguments parsed from `argv`. */
  readonly pilotArgs: PilotArgs | null;
  /** load only: in a dry-run, skip when the ledger has no header yet. */
  readonly needsLedger: boolean;
}

export interface Plan {
  readonly stages: readonly StagePlan[];
  /** The roster email-domain list every stage sees (flags plus the existing env value). */
  readonly agencyDomains: readonly string[];
}

/** Env value (comma list) plus the flag domains, lower-cased, de-duplicated, env order first. */
export function mergeAgencyDomains(
  envValue: string | undefined,
  flagDomains: readonly string[],
): string[] {
  const fromEnv = (envValue ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  return [...new Set([...fromEnv, ...flagDomains.map((d) => d.toLowerCase())])];
}

const repeat = (flag: string, values: readonly string[]): string[] =>
  values.flatMap((v) => [flag, v]);
const opt = (flag: string, v: string | null): string[] => (v === null ? [] : [flag, v]);

export function buildPlan(args: CastingArgs, envAgencyDomains: string | undefined): Plan {
  const domains = mergeAgencyDomains(envAgencyDomains, args.agencyDomains);
  const base = ['--account-id', args.accountId];
  const win = ['--window-start', args.windowStart];
  const stages: StagePlan[] = [];

  for (const stage of args.stages) {
    const apply = stage === 't3' ? args.applyT3 : args.apply;
    const applyFlag = apply && stage !== 't3' ? ['--apply'] : [];
    let argv: string[] = [];
    let skipReason: string | null = null;
    let pilotArgs: PilotArgs | null = null;
    let needsLedger = false;

    switch (stage) {
      case 't1':
        argv = [
          ...base,
          ...win,
          ...repeat('--agency-domain', domains),
          ...repeat('--known-prefix', args.knownPrefixes),
          ...opt('--budget-seconds', args.budgetSeconds),
          ...opt('--chunk-size', args.chunkSize),
          ...opt('--resume-run-id', args.resume.t1 ?? null),
          ...applyFlag,
        ];
        parseT1Args(argv);
        break;
      case 't2':
        argv = [
          ...base,
          ...win,
          ...repeat('--agency-domain', domains),
          ...repeat('--unknown-start-date', args.unknownStartDates),
          ...opt('--budget-seconds', args.budgetSeconds),
          ...opt('--chunk-size', args.chunkSize),
          ...opt('--resume-run-id', args.resume.t2 ?? null),
          ...applyFlag,
        ];
        parseT2Args(argv);
        break;
      case 't3':
        argv = [
          ...base,
          ...win,
          '--sample-size',
          String(args.sampleSize),
          '--sample-seed',
          args.sampleSeed as string,
          ...opt('--model', args.model),
          ...opt('--thinking', args.thinking),
          ...opt('--variant', args.variant),
          ...opt('--parallel', args.parallel),
          ...(args.readText && !apply ? ['--read-text'] : []),
          ...(args.retryFailed ? ['--retry-failed'] : []),
          ...repeat('--unknown-start-date', args.unknownStartDates),
          ...opt('--ledger-dir', args.ledgerDir),
          ...(apply
            ? ['--apply', '--max-cells', String(args.maxCells), '--max-usd', String(args.maxUsd)]
            : []),
        ];
        pilotArgs = parsePilotArgs(argv);
        break;
      case 'load':
        if (args.ledgerDir === null) {
          skipReason = 'no --ledger-dir given: nothing to load';
          break;
        }
        argv = [
          '--ledger-dir',
          args.ledgerDir,
          ...base,
          ...repeat('--agency-domain', domains),
          ...repeat('--unknown-start-date', args.unknownStartDates),
          ...applyFlag,
        ];
        parseLoadArgs(argv);
        needsLedger = !apply;
        break;
      case 'fusion':
        argv = [
          ...base,
          ...repeat('--unknown-start-date', args.unknownStartDates),
          ...opt('--chunk-size', args.chunkSize),
          ...applyFlag,
        ];
        parseFusionArgs(argv);
        break;
    }
    stages.push({ stage, apply, argv, skipReason, pilotArgs, needsLedger });
  }
  return { stages, agencyDomains: domains };
}
