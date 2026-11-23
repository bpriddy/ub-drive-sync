import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BeforeApplyInfo } from '../../t3/pilot';
import type { CastingArgs } from '../args';
import { parseCastingArgs } from '../args';
import type { RunDeps, StageFns } from '../run';

export const ACCT = '11111111-1111-4111-8111-111111111111';
export const RUN_ID = '22222222-2222-4222-8222-222222222222';
export const WINDOW = '2021-11-20';

export const SAMPLE = ['--sample-size', '50', '--sample-seed', 'seed-a'];
export const PLAN_FLAGS = ['--account-id', ACCT, '--window-start', WINDOW, ...SAMPLE];

export function castingArgs(...extra: string[]): CastingArgs {
  return parseCastingArgs([...PLAN_FLAGS, ...extra]);
}

export function paidFlags(dir: string, extra: string[] = []): string[] {
  return [
    '--apply-t3',
    '--max-cells',
    '50',
    '--max-usd',
    '5',
    '--ledger-dir',
    dir,
    '--expect-cells',
    '50',
    ...extra,
  ];
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'casting-run-test-'));
}

export interface Call {
  readonly stage: string;
  readonly argv: readonly string[];
}

export interface Fakes {
  readonly calls: Call[];
  readonly lines: string[];
  readonly domainsApplied: string[];
  readonly stages: StageFns;
  deps(over?: Partial<RunDeps>): RunDeps;
  /** Return codes per stage (default 0); `throw` makes the stage throw instead. */
  codes: Partial<Record<'t1' | 't2' | 't3' | 'load' | 'fusion', number | Error>>;
  /** What the fake T3 reports to the orchestrator's beforeApply hook (apply only). */
  t3Info: BeforeApplyInfo | null;
}

/** All stages are fakes: nothing here reaches a DB, Drive or a model. */
export function fakes(): Fakes {
  const calls: Call[] = [];
  const lines: string[] = [];
  const domainsApplied: string[] = [];
  const f: Fakes = {
    calls,
    lines,
    domainsApplied,
    codes: {},
    t3Info: null,
    stages: undefined as unknown as StageFns,
    deps: (over = {}) => ({
      stages: f.stages,
      out: (l) => lines.push(l),
      env: {},
      repoRoots: ['/repo-that-does-not-exist'],
      now: () => new Date('2026-11-20T10:00:00Z'),
      applyAgencyDomains: (csv) => domainsApplied.push(csv),
      isPidAlive: () => false,
      ...over,
    }),
  };
  const run =
    (stage: 't1' | 't2' | 'load' | 'fusion') =>
    async (argv: readonly string[]): Promise<number> => {
      calls.push({ stage, argv });
      const c = f.codes[stage] ?? 0;
      if (c instanceof Error) throw c;
      return c;
    };
  (f as { stages: StageFns }).stages = {
    t1: run('t1'),
    t2: run('t2'),
    load: run('load'),
    fusion: run('fusion'),
    t3: async (argv, hooks) => {
      calls.push({ stage: 't3', argv });
      const c = f.codes.t3 ?? (argv.includes('--apply') ? 0 : 3);
      if (c instanceof Error) throw c;
      if (argv.includes('--apply') && f.t3Info) await hooks.beforeApply(f.t3Info);
      return c;
    },
  };
  return f;
}

export const records = (lines: readonly string[]): Record<string, unknown>[] =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>);

export const GOOD_ENV = { GEMINI_USE_ENTERPRISE: 'true', GCP_PROJECT_ID: 'some-project' };
