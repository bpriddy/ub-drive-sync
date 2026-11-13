/**
 * eval-vision-lib.ts — the parts of scripts/eval-vision.ts that make no model
 * call and touch no Drive or database: the fixture format, the plan (call
 * count and cost, $0), the gold-fact score and the spend guard for media
 * calls. The unit suite covers all of it.
 *
 * Fixtures are PDFs, each with an optional gold file of facts that must and
 * must not appear in a transcription. Customer PDFs stay outside the
 * repository (the script refuses otherwise); the synthetic example set is in
 * scripts/eval-vision-example.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LlmCompletionRequest, LlmCompletionResult, LlmDriver } from '../src/ai';
import {
  Budget,
  BudgetStop,
  DRIVER_ATTEMPTS,
  chargeFor,
  costUsd,
  type CallRecord,
} from './eval-ideas-lib';

// ── Measured rates (the spec's derivation from the first eval, replace with a run's) ──

/** Input tokens per PDF page: (4,922 - 719) / 8 extra pages in the first eval. */
export const INPUT_TOKENS_PER_PAGE = 525;
/** Output tokens per page of a dense deck: 3,223 / 9 pages. */
export const OUTPUT_TOKENS_PER_PAGE = 358;
/** The transcription prompt and the framing around the media. */
export const PROMPT_OVERHEAD_TOKENS = 300;

// ── Fixtures ────────────────────────────────────────────────────────────────

const GoldSchema = z
  .object({
    /** Facts a good transcription contains (case and spacing ignored). */
    must_include: z.array(z.string().min(1)).default([]),
    /** Strings that must NOT appear: injected or invented content. */
    must_not_include: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Gold = z.infer<typeof GoldSchema>;

export interface VisionFixture {
  id: string;
  /** Absolute path of the PDF. */
  file: string;
  bytes: number;
  gold: Gold;
}

const GOLD_SUFFIX = '.gold.json';

/** Every `<id>.pdf` in `dir`, with its `<id>.gold.json` when there is one (an empty gold otherwise). */
export function loadFixtures(dir: string): VisionFixture[] {
  const names = fs.readdirSync(dir);
  const ids = names.filter((n) => n.endsWith('.pdf')).map((n) => n.slice(0, -'.pdf'.length));
  if (ids.length === 0) throw new Error(`fixtures in ${dir}: no *.pdf files`);
  const orphans = names
    .filter((n) => n.endsWith(GOLD_SUFFIX))
    .map((n) => n.slice(0, -GOLD_SUFFIX.length))
    .filter((id) => !ids.includes(id));
  if (orphans.length > 0) {
    throw new Error(
      `fixtures in ${dir}: ${orphans.map((id) => `${id}${GOLD_SUFFIX}`).join(', ')} has no PDF`,
    );
  }
  return ids.sort().map((id) => {
    const file = path.join(dir, `${id}.pdf`);
    const goldPath = path.join(dir, `${id}${GOLD_SUFFIX}`);
    const raw: unknown = fs.existsSync(goldPath)
      ? JSON.parse(fs.readFileSync(goldPath, 'utf8'))
      : {};
    const parsed = GoldSchema.safeParse(raw);
    if (!parsed.success) {
      const why = parsed.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`);
      throw new Error(`${id}${GOLD_SUFFIX}: ${why.join('; ')}`);
    }
    return { id, file, bytes: fs.statSync(file).size, gold: parsed.data };
  });
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface Args {
  mode: 'run' | 'score';
  fixtures: string;
  out: string | null;
  run: string | null;
  maxUsd: number | null;
  limit: number | null;
  plan: boolean;
  allowMock: boolean;
}

const VALUE_FLAGS = ['--fixtures', '--out', '--run', '--max-usd', '--limit'] as const;
const BOOLEAN_FLAGS = ['--plan', '--allow-mock'] as const;

/**
 * Strict on purpose: a paid run must not start on a typo. Unknown flags, a
 * flag without a value, and a value that looks like a flag all throw.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const [mode, ...rest] = argv;
  if (mode !== 'run' && mode !== 'score')
    throw new Error('first argument must be "run" or "score"');
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if ((VALUE_FLAGS as readonly string[]).includes(tok)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${tok} needs a value`);
      values.set(tok, v);
      i++;
    } else if ((BOOLEAN_FLAGS as readonly string[]).includes(tok)) {
      flags.add(tok);
    } else {
      throw new Error(`unknown argument ${tok}`);
    }
  }
  const nonEmpty = (v: string | undefined) => (v === undefined || v === '' ? null : v);
  const num = (flag: string): number | null => {
    const raw = values.get(flag);
    if (raw === undefined) return null;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) throw new Error(`${flag} must be a number`);
    return n;
  };
  const fixtures = nonEmpty(values.get('--fixtures')) ?? nonEmpty(env['EVAL_VISION_FIXTURES']);
  if (fixtures === null) throw new Error('--fixtures <dir> (or EVAL_VISION_FIXTURES) is required');
  const maxUsd = num('--max-usd');
  if (maxUsd !== null && !(maxUsd > 0)) throw new Error('--max-usd must be a positive number');
  const limit = num('--limit');
  if (limit !== null && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error('--limit must be a positive integer');
  }
  const args: Args = {
    mode,
    fixtures: path.resolve(fixtures),
    out: nonEmpty(values.get('--out')) ?? nonEmpty(env['EVAL_VISION_OUT']),
    run: nonEmpty(values.get('--run')),
    maxUsd,
    limit,
    plan: flags.has('--plan'),
    allowMock: flags.has('--allow-mock'),
  };
  if (mode === 'score' && args.run === null) throw new Error('score needs --run <run file>');
  if (mode === 'run' && !args.plan) {
    if (args.maxUsd === null) throw new Error('run needs --max-usd');
    if (args.out === null) throw new Error('run needs --out <dir> (or EVAL_VISION_OUT)');
  }
  return args;
}

// ── The plan ($0) ───────────────────────────────────────────────────────────

export interface PlanLimits {
  maxPages: number;
  maxOutputTokens: number;
  maxFileBytes: number;
}

export interface PlanRow {
  id: string;
  bytes: number;
  /** null when the page count could not be read: the page cap is assumed. */
  pages: number | null;
  /** Would the scan core send this file to vision (size and page caps)? */
  eligible: boolean;
  inputTokens: number;
  expectedUsd: number;
  /** One attempt that runs to the whole output allowance. */
  worstAttemptUsd: number;
}

export interface Plan {
  calls: number;
  skipped: number;
  expectedUsd: number;
  /** Every call at its full output allowance, one attempt each. */
  worstUsd: number;
  rows: PlanRow[];
}

/**
 * The cost of the vision arm, from page counts and the measured rates. No
 * model, Drive or database involved: the text-layer arm is free and not
 * counted. A file the caps would keep on the text layer is skipped, as the
 * scan core would skip it.
 */
export function planVision(
  files: Array<{ id: string; bytes: number; pages: number | null }>,
  limits: PlanLimits,
): Plan {
  const rows: PlanRow[] = files.map((f) => {
    const pages = f.pages ?? limits.maxPages;
    const eligible = f.bytes <= limits.maxFileBytes && pages <= limits.maxPages;
    const inputTokens = PROMPT_OVERHEAD_TOKENS + INPUT_TOKENS_PER_PAGE * pages;
    const expectedOut = Math.min(OUTPUT_TOKENS_PER_PAGE * pages, limits.maxOutputTokens);
    return {
      id: f.id,
      bytes: f.bytes,
      pages: f.pages,
      eligible,
      inputTokens,
      expectedUsd: costUsd({
        promptTokens: inputTokens,
        outputTokens: expectedOut,
        thoughtsTokens: 0,
      }),
      worstAttemptUsd: costUsd({
        promptTokens: inputTokens,
        outputTokens: limits.maxOutputTokens,
        thoughtsTokens: 0,
      }),
    };
  });
  const sent = rows.filter((r) => r.eligible);
  return {
    calls: sent.length,
    skipped: rows.length - sent.length,
    expectedUsd: sent.reduce((s, r) => s + r.expectedUsd, 0),
    worstUsd: sent.reduce((s, r) => s + r.worstAttemptUsd, 0),
    rows,
  };
}

// ── Gold score ──────────────────────────────────────────────────────────────

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface GoldScore {
  /** Share of must_include facts found; null when the gold lists none. */
  recall: number | null;
  missing: string[];
  /** must_not_include strings that appeared. */
  forbidden: string[];
}

export function scoreText(text: string, gold: Gold): GoldScore {
  const haystack = norm(text);
  const missing = gold.must_include.filter((f) => !haystack.includes(norm(f)));
  const forbidden = gold.must_not_include.filter((f) => haystack.includes(norm(f)));
  return {
    recall:
      gold.must_include.length === 0
        ? null
        : (gold.must_include.length - missing.length) / gold.must_include.length,
    missing,
    forbidden,
  };
}

// ── The spend guard for media calls ─────────────────────────────────────────

/**
 * Like eval-ideas-lib's guardDriver, but the worst case counts the media: the
 * PDF's tokens are not in `req.prompt`. `inputTokens()` says how many tokens
 * the file now being sent will cost (from its page count), and a call starts
 * only if one attempt at its full output allowance still fits under the cap.
 * A finished call is charged its reported usage; a failed one the worst case
 * of every driver attempt. `free` (the mock driver) charges nothing.
 */
export function guardMediaDriver(
  llm: LlmDriver,
  budget: Budget,
  calls: CallRecord[],
  free: boolean,
  inputTokens: () => number,
): void {
  const complete = llm.complete.bind(llm);
  llm.complete = async (req: LlmCompletionRequest): Promise<LlmCompletionResult> => {
    const worst = free
      ? 0
      : costUsd({
          promptTokens: inputTokens(),
          outputTokens: req.maxOutputTokens ?? 65_536,
          thoughtsTokens: 0,
        });
    if (!budget.allows(worst)) throw new BudgetStop(budget.spentUsd, worst, budget.maxUsd);
    const started = Date.now();
    try {
      const res = await complete(req);
      const u = res.usage;
      const usd = free ? 0 : chargeFor(u, worst);
      budget.add(usd);
      calls.push({
        tag: req.tag ?? null,
        ok: true,
        promptTokens: u?.promptTokens ?? null,
        outputTokens: u?.outputTokens ?? null,
        thoughtsTokens: u?.thoughtsTokens ?? null,
        usd,
        latencyMs: Date.now() - started,
      });
      return res;
    } catch (err) {
      const usd = worst * DRIVER_ATTEMPTS;
      budget.add(usd);
      calls.push({
        tag: req.tag ?? null,
        ok: false,
        promptTokens: null,
        outputTokens: null,
        thoughtsTokens: null,
        usd,
        latencyMs: Date.now() - started,
      });
      throw err;
    }
  };
}

// ── The run file ────────────────────────────────────────────────────────────

export interface ArmResult {
  chars: number;
  text: string;
  score: GoldScore;
  error: string | null;
  usd: number;
  promptTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
  latencyMs: number;
}

export interface FileRun {
  id: string;
  bytes: number;
  pages: number | null;
  textLayer: ArmResult;
  /** null when the budget stopped the run before this file. */
  vision: ArmResult | null;
}

export interface RunFile {
  version: 1;
  kind: 'eval-vision-run';
  startedAt: string;
  finishedAt: string | null;
  driver: string;
  model: string;
  maxUsd: number;
  spentUsd: number;
  stoppedByBudget: string | null;
  files: FileRun[];
}

export function isRunFile(x: unknown): x is RunFile {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return r['kind'] === 'eval-vision-run' && r['version'] === 1 && Array.isArray(r['files']);
}

/** Re-score a saved run against the (possibly corrected) gold, $0. */
export function rescore(run: RunFile, fixtures: VisionFixture[]): RunFile {
  const gold = new Map(fixtures.map((f) => [f.id, f.gold]));
  const again = (arm: ArmResult, g: Gold): ArmResult => ({ ...arm, score: scoreText(arm.text, g) });
  return {
    ...run,
    files: run.files.map((f) => {
      const g = gold.get(f.id) ?? { must_include: [], must_not_include: [] };
      return {
        ...f,
        textLayer: again(f.textLayer, g),
        vision: f.vision ? again(f.vision, g) : null,
      };
    }),
  };
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

/** The stdout table: one line per file and arm, then totals. Ids and numbers only. */
export function formatReport(run: RunFile): string {
  const lines: string[] = [];
  let usd = 0;
  for (const f of run.files) {
    const t = f.textLayer;
    lines.push(
      `${f.id}  ${f.pages ?? '?'}p  text-layer: ${t.chars} chars, recall ${pct(t.score.recall)}, forbidden ${t.score.forbidden.length}`,
    );
    const v = f.vision;
    if (v) {
      usd += v.usd;
      lines.push(
        `${' '.repeat(f.id.length)}        vision:     ${v.error ? `error ${v.error}` : `${v.chars} chars, recall ${pct(v.score.recall)}, forbidden ${v.score.forbidden.length}`}, ${v.promptTokens ?? '?'} in / ${v.outputTokens ?? '?'} out / ${v.thoughtsTokens ?? '?'} thoughts, $${v.usd.toFixed(4)}, ${v.latencyMs} ms`,
      );
    }
  }
  lines.push(
    `vision arm total $${usd.toFixed(4)} over ${run.files.filter((f) => f.vision).length} files`,
  );
  if (run.stoppedByBudget) lines.push(`stopped: ${run.stoppedByBudget}`);
  return lines.join('\n');
}

/** An error as one short line, for the progress output and the run file. */
export function oneLine(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 300);
}
