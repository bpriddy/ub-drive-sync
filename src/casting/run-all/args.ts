/**
 * Command line of `casting-run`: one account, the whole casting chain, with guards. Dry-run
 * (PLAN) is the default. Unknown flags are errors: a mistyped `--aply` must not silently mean
 * "plan only", and a mistyped `--max-cell` must not mean "no limit".
 *
 *   --account-id UUID        exactly one account per invocation
 *   --window-start DATE      required; the same value goes to t1, t2 and t3
 *   --stages LIST            subset of t1,t2,t3,load,fusion (default all; the order is fixed)
 *   --apply                  free DB writes: t1, t2, load, fusion
 *   --apply-t3               the PAID model stage; needs every flag below it
 *     --sample-size N --sample-seed S --max-cells N --max-usd X --ledger-dir ABS --expect-cells N
 *   --allow-repeat-paid      only with --apply-t3: accept a sibling ledger that already paid
 *   --model M --thinking L --variant V --parallel N --read-text --retry-failed   (T3 passthrough)
 *   --agency-domain D        repeatable; all stages
 *   --unknown-start-date D   repeatable; all stages that take it
 *   --known-prefix P         repeatable; t1 only
 *   --budget-seconds N       t1 and t2
 *   --chunk-size N           t1, t2 and fusion
 *   --resume t1=ID,t2=ID     paused t1/t2 run ids (needs --apply)
 *
 * This file is pure: no config, Prisma, logger or model code.
 */
import path from 'node:path';

export const STAGE_ORDER = ['t1', 't2', 't3', 'load', 'fusion'] as const;
export type StageName = (typeof STAGE_ORDER)[number];

export interface CastingArgs {
  readonly accountId: string;
  readonly windowStart: string;
  readonly stages: readonly StageName[];
  readonly apply: boolean;
  readonly applyT3: boolean;
  readonly sampleSize: number | null;
  readonly sampleSeed: string | null;
  readonly maxCells: number | null;
  readonly maxUsd: number | null;
  readonly ledgerDir: string | null;
  readonly expectCells: number | null;
  readonly allowRepeatPaid: boolean;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly variant: string | null;
  readonly parallel: string | null;
  readonly readText: boolean;
  readonly retryFailed: boolean;
  readonly agencyDomains: readonly string[];
  readonly unknownStartDates: readonly string[];
  readonly knownPrefixes: readonly string[];
  readonly budgetSeconds: string | null;
  readonly chunkSize: string | null;
  readonly resume: Readonly<{ t1?: string; t2?: string }>;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--account-id',
  '--window-start',
  '--stages',
  '--sample-size',
  '--sample-seed',
  '--max-cells',
  '--max-usd',
  '--ledger-dir',
  '--expect-cells',
  '--model',
  '--thinking',
  '--variant',
  '--parallel',
  '--agency-domain',
  '--unknown-start-date',
  '--known-prefix',
  '--budget-seconds',
  '--chunk-size',
  '--resume',
]);
const BOOL_FLAGS: ReadonlySet<string> = new Set([
  '--apply',
  '--apply-t3',
  '--allow-repeat-paid',
  '--read-text',
  '--retry-failed',
]);
const REPEATABLE: ReadonlySet<string> = new Set([
  '--agency-domain',
  '--unknown-start-date',
  '--known-prefix',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (v: string): boolean => ISO.test(v) && !Number.isNaN(Date.parse(v));

function positiveInt(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be an integer >= 1`);
  return n;
}

function parseStages(v: string): StageName[] {
  const wanted = v.split(',').map((s) => s.trim());
  for (const s of wanted) {
    if (!(STAGE_ORDER as readonly string[]).includes(s)) {
      throw new Error(`--stages: unknown stage "${s}" (known: ${STAGE_ORDER.join(', ')})`);
    }
  }
  // The order is fixed whatever the user typed: free stages first, the paid one last-but-two.
  return STAGE_ORDER.filter((s) => wanted.includes(s));
}

function parseResume(v: string): { t1?: string; t2?: string } {
  const out: { t1?: string; t2?: string } = {};
  for (const part of v.split(',')) {
    const [key, id, ...rest] = part.split('=');
    if ((key !== 't1' && key !== 't2') || id === undefined || rest.length > 0 || !UUID.test(id)) {
      throw new Error('--resume must look like t1=<uuid>,t2=<uuid>');
    }
    if (out[key] !== undefined) throw new Error(`--resume names ${key} twice`);
    out[key] = id.toLowerCase();
  }
  return out;
}

export function parseCastingArgs(argv: readonly string[]): CastingArgs {
  const single = new Map<string, string>();
  const many = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    if (BOOL_FLAGS.has(a)) {
      if (bools.has(a)) throw new Error(`${a} given twice`);
      bools.add(a);
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${a} needs a value`);
    i++;
    if (REPEATABLE.has(a)) {
      const list = many.get(a) ?? [];
      const v = a === '--agency-domain' ? next.trim().toLowerCase() : next;
      if (!list.includes(v)) list.push(v);
      many.set(a, list);
    } else {
      if (single.has(a)) throw new Error(`${a} given twice`);
      single.set(a, next);
    }
  }

  const accountId = single.get('--account-id');
  if (accountId === undefined || !UUID.test(accountId)) {
    throw new Error('--account-id UUID is required (exactly one account per run)');
  }
  const windowStart = single.get('--window-start');
  if (windowStart === undefined || !isIsoDate(windowStart)) {
    throw new Error('--window-start YYYY-MM-DD is required');
  }
  const stages = single.has('--stages')
    ? parseStages(single.get('--stages') as string)
    : [...STAGE_ORDER];
  if (stages.length === 0) throw new Error('--stages is empty');

  const apply = bools.has('--apply');
  const applyT3 = bools.has('--apply-t3');
  const has = (k: string): boolean => single.has(k);
  const int = (k: string): number | null =>
    has(k) ? positiveInt(k, single.get(k) as string) : null;

  const sampleSize = int('--sample-size');
  const sampleSeed = single.get('--sample-seed') ?? null;
  if (sampleSeed !== null && sampleSeed.trim() === '') throw new Error('--sample-seed is empty');
  const maxCells = int('--max-cells');
  const expectCells = int('--expect-cells');
  let maxUsd: number | null = null;
  if (has('--max-usd')) {
    maxUsd = Number(single.get('--max-usd'));
    if (!Number.isFinite(maxUsd) || !(maxUsd > 0))
      throw new Error('--max-usd must be a number > 0');
  }
  const ledgerDir = single.get('--ledger-dir') ?? null;
  if (ledgerDir !== null && !path.isAbsolute(ledgerDir)) {
    throw new Error('--ledger-dir must be an absolute path');
  }

  const hasT3 = stages.includes('t3');
  if (applyT3) {
    if (!hasT3) throw new Error('--apply-t3 needs t3 in --stages');
    const missing = [
      ['--sample-size', sampleSize],
      ['--sample-seed', sampleSeed],
      ['--max-cells', maxCells],
      ['--max-usd', maxUsd],
      ['--ledger-dir', ledgerDir],
      ['--expect-cells', expectCells],
    ]
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`--apply-t3 needs ${missing.join(', ')}; nothing was started`);
    }
  } else {
    for (const k of ['--max-cells', '--max-usd', '--expect-cells']) {
      if (has(k)) throw new Error(`${k} only means something with --apply-t3`);
    }
    if (bools.has('--allow-repeat-paid')) throw new Error('--allow-repeat-paid needs --apply-t3');
  }
  if (hasT3 && (sampleSize === null || sampleSeed === null)) {
    // The PLAN prints a PROPOSAL for a named sample; a silent default would hide the pool.
    throw new Error('t3 is in --stages: --sample-size and --sample-seed are required');
  }
  if (!hasT3) {
    for (const k of ['--model', '--thinking', '--variant', '--parallel']) {
      if (has(k)) throw new Error(`${k} only means something with t3 in --stages`);
    }
  }
  if (apply && stages.includes('load') && ledgerDir === null) {
    throw new Error(
      '--apply with the load stage needs --ledger-dir (or leave load out of --stages)',
    );
  }

  const resume = has('--resume') ? parseResume(single.get('--resume') as string) : {};
  if (Object.keys(resume).length > 0) {
    if (!apply) throw new Error('--resume needs --apply');
    for (const k of Object.keys(resume)) {
      if (!stages.includes(k as StageName))
        throw new Error(`--resume names ${k}, which is not in --stages`);
    }
  }

  const unknownStartDates = many.get('--unknown-start-date') ?? [];
  for (const d of unknownStartDates) {
    if (!isIsoDate(d)) throw new Error('--unknown-start-date must be YYYY-MM-DD');
  }

  return {
    accountId: accountId.toLowerCase(),
    windowStart,
    stages,
    apply,
    applyT3,
    sampleSize,
    sampleSeed,
    maxCells,
    maxUsd,
    ledgerDir,
    expectCells,
    allowRepeatPaid: bools.has('--allow-repeat-paid'),
    model: single.get('--model') ?? null,
    thinking: single.get('--thinking') ?? null,
    variant: single.get('--variant') ?? null,
    parallel: single.get('--parallel') ?? null,
    readText: bools.has('--read-text'),
    retryFailed: bools.has('--retry-failed'),
    agencyDomains: many.get('--agency-domain') ?? [],
    unknownStartDates,
    knownPrefixes: many.get('--known-prefix') ?? [],
    budgetSeconds: single.get('--budget-seconds') ?? null,
    chunkSize: single.get('--chunk-size') ?? null,
    resume,
  };
}
