/**
 * eval-vision.ts — vision against the text layer for PDFs, on a local set of
 * PDFs with gold facts (DRIVE_VISION_PDF cutover, step 1).
 *
 * Two modes:
 *   run    PAID unless --plan. Per PDF: the text layer (free, local), then one
 *          vision call (the production transcription call). Saves both texts
 *          and the numbers, and scores them against the gold facts. Every vision
 *          call is one Gemini request: run it only with an explicit go, and
 *          always with --max-usd.
 *   score  $0. Re-scores a saved run against the fixtures' gold files.
 *
 * `run --plan` reads the local PDFs, counts their pages and prints the call
 * count and the cost estimate. It loads no model client, makes no call, and
 * reaches neither Drive nor a database.
 *
 * PDFs and outputs may hold customer content, so both must lie outside this
 * repository; the script refuses otherwise. The one exception is the
 * synthetic example set in scripts/eval-vision-example.
 *
 * Usage (LOCAL only):
 *
 *   npm run eval-vision -- run --fixtures <dir> --plan
 *   npm run eval-vision -- run --fixtures <dir> --out <dir> --max-usd 1 [--limit N]
 *   npm run eval-vision -- score --fixtures <dir> --run <run file> [--out <dir>]
 *
 *   --allow-mock   let run use the mock driver (no Gemini set up): a $0 smoke
 *                  test of the plumbing; the mock returns no transcription
 *
 * EVAL_VISION_FIXTURES and EVAL_VISION_OUT stand in for --fixtures and --out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Budget, BudgetStop, isInside } from './eval-ideas-lib';
import {
  INPUT_TOKENS_PER_PAGE,
  PROMPT_OVERHEAD_TOKENS,
  formatReport,
  guardMediaDriver,
  isRunFile,
  loadFixtures,
  oneLine,
  parseArgs,
  planVision,
  rescore,
  scoreText,
  type Args,
  type ArmResult,
  type FileRun,
  type RunFile,
  type VisionFixture,
} from './eval-vision-lib';

const REPO_ROOT = path.resolve(__dirname, '..');
const EXAMPLE_DIR = path.join(__dirname, 'eval-vision-example');

function fail(msg: string): never {
  console.error(`eval-vision: ${msg}`);
  process.exit(1);
}

/** Customer content stays out of the repo: PDFs (bar the synthetic example) and every output. */
function checkPaths(args: Args): void {
  if (isInside(args.fixtures, REPO_ROOT) && !isInside(args.fixtures, EXAMPLE_DIR)) {
    fail(`--fixtures ${args.fixtures} is inside the repository; keep fixtures outside it`);
  }
  if (args.out !== null && isInside(args.out, REPO_ROOT)) {
    fail(
      `--out ${args.out} is inside the repository; outputs hold transcriptions, keep them outside it`,
    );
  }
}

/** Pages of a PDF, counted on a copy (pdf.js detaches what it is given); null if unreadable. */
async function pagesOf(file: string): Promise<number | null> {
  try {
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)), { verbosity: 0 });
    try {
      return pdf.numPages;
    } finally {
      await pdf.destroy();
    }
  } catch {
    return null;
  }
}

async function textLayerOf(file: string): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)), { verbosity: 0 });
  try {
    return (await extractText(pdf, { mergePages: true })).text.trim();
  } finally {
    await pdf.destroy();
  }
}

/** The vision caps, read from config alone (no model client is loaded). */
async function limits() {
  process.env['DATABASE_URL'] ||= 'postgresql://unused@localhost:1/unused';
  const { config } = await import('../src/config');
  return {
    maxPages: config.DRIVE_VISION_MAX_PDF_PAGES,
    maxOutputTokens: config.DRIVE_VISION_MAX_OUTPUT_TOKENS,
    maxFileBytes: config.DRIVE_VISION_MAX_FILE_SIZE_BYTES,
  };
}

async function plan(fixtures: VisionFixture[]): Promise<void> {
  const files = [];
  for (const f of fixtures) files.push({ id: f.id, bytes: f.bytes, pages: await pagesOf(f.file) });
  const p = planVision(files, await limits());
  console.log(
    `plan: ${fixtures.length} PDFs, ${p.calls} vision calls (${p.skipped} kept on the text layer by the caps); no call made`,
  );
  for (const r of p.rows) {
    console.log(
      `  ${r.id}: ${r.bytes} bytes, ${r.pages ?? 'pages unknown (cap assumed)'}p, ${r.eligible ? `~${r.inputTokens} input tokens, expected $${r.expectedUsd.toFixed(4)}, worst attempt $${r.worstAttemptUsd.toFixed(4)}` : 'over a cap: text layer only'}`,
    );
  }
  console.log(
    `  total: expected ~$${p.expectedUsd.toFixed(2)}, worst case $${p.worstUsd.toFixed(2)} (one attempt per call at its full output allowance; the driver may retry)`,
  );
  console.log(
    `  rates: ${INPUT_TOKENS_PER_PAGE} input and 358 output tokens per page, ${PROMPT_OVERHEAD_TOKENS} prompt tokens per call; derived from an 8-file run, not measured on this set`,
  );
}

const emptyArm = (error: string | null, text = ''): ArmResult => ({
  chars: text.length,
  text,
  score: { recall: null, missing: [], forbidden: [] },
  error,
  usd: 0,
  promptTokens: null,
  outputTokens: null,
  thoughtsTokens: null,
  latencyMs: 0,
});

async function run(args: Args, fixtures: VisionFixture[]): Promise<void> {
  if (args.maxUsd === null) fail('run needs --max-usd');
  if (args.out === null) fail('run needs --out <dir> (or EVAL_VISION_OUT)');
  process.env['DATABASE_URL'] ||= 'postgresql://unused@localhost:1/unused';
  const ai = await import('../src/ai');
  const { visionExtractPdf } = await import('../src/drive/extract-vision');
  const llm = ai.defaultLlm;
  const free = llm.name === 'mock';
  if (free && !args.allowMock) {
    fail(
      'no Gemini driver is configured (the mock returns no transcription); pass --allow-mock for a smoke test',
    );
  }
  console.log(
    `driver ${llm.name}, model ${ai.DEFAULT_GEMINI_MODEL}, ${fixtures.length} PDFs, cap $${args.maxUsd}`,
  );

  const budget = new Budget(args.maxUsd);
  const calls: Parameters<typeof guardMediaDriver>[2] = [];
  let pagesNow = 1;
  guardMediaDriver(
    llm,
    budget,
    calls,
    free,
    () => PROMPT_OVERHEAD_TOKENS + INPUT_TOKENS_PER_PAGE * pagesNow,
  );

  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const runFile: RunFile = {
    version: 1,
    kind: 'eval-vision-run',
    startedAt,
    finishedAt: null,
    driver: llm.name,
    model: ai.DEFAULT_GEMINI_MODEL,
    maxUsd: args.maxUsd,
    spentUsd: 0,
    stoppedByBudget: null,
    files: [],
  };
  const runPath = path.join(out, `eval-vision-${startedAt.replace(/[:.]/g, '-')}.json`);
  // Write-then-rename, so a kill mid-write never leaves a truncated run file.
  const save = () => {
    runFile.spentUsd = budget.spentUsd;
    fs.writeFileSync(`${runPath}.tmp`, JSON.stringify(runFile, null, 2));
    fs.renameSync(`${runPath}.tmp`, runPath);
  };

  for (const [i, f] of fixtures.entries()) {
    const pages = await pagesOf(f.file);
    pagesNow = pages ?? 50;
    let layerText = '';
    let layerError: string | null = null;
    const layerStarted = Date.now();
    try {
      layerText = await textLayerOf(f.file);
    } catch (err) {
      layerError = oneLine(err);
    }
    const textLayer: ArmResult = {
      ...emptyArm(layerError, layerText),
      score: scoreText(layerText, f.gold),
      latencyMs: Date.now() - layerStarted,
    };

    let vision: ArmResult;
    const before = calls.length;
    const started = Date.now();
    try {
      const res = await visionExtractPdf(fs.readFileSync(f.file));
      const call = calls[before];
      vision = {
        ...emptyArm(null, res.text),
        score: scoreText(res.text, f.gold),
        usd: call?.usd ?? 0,
        promptTokens: res.usage?.promptTokens ?? null,
        outputTokens: res.usage?.outputTokens ?? null,
        thoughtsTokens: res.usage?.thoughtsTokens ?? null,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof BudgetStop) {
        runFile.stoppedByBudget = err.message;
        runFile.files.push({ id: f.id, bytes: f.bytes, pages, textLayer, vision: null });
        break;
      }
      vision = {
        ...emptyArm(oneLine(err)),
        usd: calls[before]?.usd ?? 0,
        latencyMs: Date.now() - started,
      };
    }
    const row: FileRun = { id: f.id, bytes: f.bytes, pages, textLayer, vision };
    runFile.files.push(row);
    save();
    console.log(
      `[${i + 1}/${fixtures.length}] ${f.id}: vision ${vision.error ?? `${vision.chars} chars`}, total $${budget.spentUsd.toFixed(4)}`,
    );
  }
  runFile.finishedAt = new Date().toISOString();
  save();
  console.log(`run saved: ${runPath}`);
  console.log(formatReport(runFile));
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  checkPaths(args);
  const all = loadFixtures(args.fixtures);
  const fixtures = args.limit !== null ? all.slice(0, args.limit) : all;

  if (args.mode === 'score') {
    if (args.run === null) fail('score needs --run <run file>');
    const saved: unknown = JSON.parse(fs.readFileSync(args.run, 'utf8'));
    if (!isRunFile(saved)) fail(`${args.run} is not an eval-vision run file`);
    const scored = rescore(saved, all);
    console.log(formatReport(scored));
    if (args.out !== null) {
      fs.mkdirSync(args.out, { recursive: true });
      const target = path.join(
        path.resolve(args.out),
        `${path.basename(args.run, '.json')}-rescored.json`,
      );
      fs.writeFileSync(target, JSON.stringify(scored, null, 2));
      console.log(`rescored run saved: ${target}`);
    }
    return;
  }
  if (args.plan) return plan(fixtures);
  return run(args, fixtures);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
