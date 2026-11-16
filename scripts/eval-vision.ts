/**
 * eval-vision.ts — vision against the text layer for PDFs, on a local set of
 * PDFs with gold facts (DRIVE_VISION_PDF cutover, step 1).
 *
 * Two modes:
 *   run    PAID unless --plan. Per PDF: the text layer (free, local), then TWO
 *          vision calls through the production path (the preset's prompt, the
 *          PDF staged in the Cloud Storage staging bucket and read by
 *          reference): pages alone (an empty text layer) and pages plus the
 *          text layer, which is what the scan sends. Saves the texts and the
 *          numbers, and scores all three against the gold facts, so the report
 *          shows whether sending the text helps. Every vision call is one
 *          Gemini request: run it only with an explicit go, and always with
 *          --max-usd.
 *   score  $0. Re-scores a saved run against the fixtures' gold files.
 *
 * The prompt is the database preset `drive.vision_extraction.v1` (a real run
 * needs DATABASE_URL), or a template file given with --preset-file: the way to
 * try a prompt before it is in the database, and to smoke-test with the mock
 * driver without one.
 *
 * `run --plan` reads the local PDFs, counts their pages and text-layer
 * characters and prints the call count and the cost estimate. It loads no model
 * client, makes no call, and reaches neither Drive, Cloud Storage nor a
 * database.
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
 *                  test of the plumbing; the mock returns no transcription and
 *                  nothing is staged
 *   --preset-file  read the prompt template from this file, not the database
 *
 * EVAL_VISION_FIXTURES and EVAL_VISION_OUT stand in for --fixtures and --out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Budget, BudgetStop, isInside } from './eval-ideas-lib';
import {
  INPUT_TOKENS_PER_PAGE,
  PROMPT_OVERHEAD_TOKENS,
  TEXT_TOKENS_PER_CHAR,
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

/** The prompt: the file given with --preset-file, else the database preset. */
async function presetFor(
  args: Args,
  ai: typeof import('../src/ai'),
  key: string,
): Promise<import('../src/ai').LoadedPreset> {
  if (args.presetFile !== null) {
    return {
      key,
      template: fs.readFileSync(args.presetFile, 'utf8'),
      model: ai.DEFAULT_GEMINI_MODEL,
      temperature: 0,
    };
  }
  try {
    return await ai.loadPreset(key);
  } catch (err) {
    return fail(
      `cannot read preset ${key} from the database (${oneLine(err)}); set DATABASE_URL or pass --preset-file <template>`,
    );
  }
}

async function plan(fixtures: VisionFixture[]): Promise<void> {
  const files = [];
  for (const f of fixtures) {
    const textChars = await textLayerOf(f.file).then(
      (t) => t.length,
      () => 0,
    );
    files.push({ id: f.id, bytes: f.bytes, pages: await pagesOf(f.file), textChars });
  }
  const p = planVision(files, await limits());
  console.log(
    `plan: ${fixtures.length} PDFs, ${p.calls} vision calls (two per PDF the caps admit: pages alone, pages plus text; ${p.skipped} PDFs kept on the text layer by the caps); no call made`,
  );
  for (const r of p.rows) {
    console.log(
      `  ${r.id}: ${r.bytes} bytes, ${r.pages ?? 'pages unknown (cap assumed)'}p, ${r.eligible ? `~${r.inputTokens} input tokens pages alone, ~${r.inputTokensWithText} with the text layer, expected $${r.expectedUsd.toFixed(4)} both arms, worst attempt $${r.worstAttemptUsd.toFixed(4)} both arms` : 'over a cap: text layer only'}`,
    );
  }
  console.log(
    `  total: expected ~$${p.expectedUsd.toFixed(2)}, worst case $${p.worstUsd.toFixed(2)} (one attempt per call at its full output allowance; the driver may retry)`,
  );
  console.log(
    `  rates: ${INPUT_TOKENS_PER_PAGE} input and 358 output tokens per page, ${PROMPT_OVERHEAD_TOKENS} prompt tokens per call, ${TEXT_TOKENS_PER_CHAR} input tokens per text-layer character; derived from an 8-file run and a rule of thumb, not measured on this set`,
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
  const { visionExtractPdf, VISION_PRESET_KEY } = await import('../src/drive/extract-vision');
  const { stagePdf } = await import('../src/drive/vision-staging');
  const { config } = await import('../src/config');
  const llm = ai.defaultLlm;
  const free = llm.name === 'mock';
  if (free && !args.allowMock) {
    fail(
      'no Gemini driver is configured (the mock returns no transcription); pass --allow-mock for a smoke test',
    );
  }
  if (!free && !config.DRIVE_VISION_STAGING_BUCKET) {
    fail('a real run stages each PDF in a bucket: set DRIVE_VISION_STAGING_BUCKET');
  }
  const preset = await presetFor(args, ai, VISION_PRESET_KEY);
  // The mock never reads media: nothing is staged for it.
  const stage = free ? async () => ({ uri: 'gs://mock/none', remove: async () => {} }) : stagePdf;
  console.log(
    `driver ${llm.name}, model ${preset.model}, ${fixtures.length} PDFs, two vision calls each, cap $${args.maxUsd}`,
  );

  const budget = new Budget(args.maxUsd);
  const calls: Parameters<typeof guardMediaDriver>[2] = [];
  let pagesNow = 1;
  let textTokensNow = 0;
  guardMediaDriver(
    llm,
    budget,
    calls,
    free,
    () => PROMPT_OVERHEAD_TOKENS + INPUT_TOKENS_PER_PAGE * pagesNow + textTokensNow,
  );

  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const runFile: RunFile = {
    version: 2,
    kind: 'eval-vision-run',
    startedAt,
    finishedAt: null,
    driver: llm.name,
    model: preset.model,
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

    // One vision arm: the production call, with `layer` as the text layer.
    // Returns null when the budget stops the run.
    const arm = async (layer: string): Promise<ArmResult | null> => {
      textTokensNow = Math.ceil(layer.length * TEXT_TOKENS_PER_CHAR);
      const before = calls.length;
      const started = Date.now();
      try {
        const res = await visionExtractPdf(fs.readFileSync(f.file), {
          preset,
          textLayer: layer,
          stage,
        });
        return {
          ...emptyArm(null, res.text),
          score: scoreText(res.text, f.gold),
          usd: calls[before]?.usd ?? 0,
          promptTokens: res.usage?.promptTokens ?? null,
          outputTokens: res.usage?.outputTokens ?? null,
          thoughtsTokens: res.usage?.thoughtsTokens ?? null,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof BudgetStop) {
          runFile.stoppedByBudget = err.message;
          return null;
        }
        return {
          ...emptyArm(oneLine(err)),
          usd: calls[before]?.usd ?? 0,
          latencyMs: Date.now() - started,
        };
      }
    };
    const visionPages = await arm('');
    const visionPagesText = visionPages === null ? null : await arm(layerText);
    const row: FileRun = {
      id: f.id,
      bytes: f.bytes,
      pages,
      textLayer,
      visionPages,
      visionPagesText,
    };
    runFile.files.push(row);
    save();
    if (visionPagesText === null) break;
    const said = (a: ArmResult) => a.error ?? `${a.chars} chars`;
    console.log(
      `[${i + 1}/${fixtures.length}] ${f.id}: pages ${said(visionPages!)}, pages+text ${said(visionPagesText)}, total $${budget.spentUsd.toFixed(4)}`,
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
