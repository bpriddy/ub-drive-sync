/** The pure parts of the vision eval: arguments, the plan, the gold score, the spend guard, re-scoring. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Budget, BudgetStop, type CallRecord } from '../eval-ideas-lib';
import {
  formatReport,
  guardMediaDriver,
  isRunFile,
  loadFixtures,
  parseArgs,
  planVision,
  rescore,
  scoreText,
  type ArmResult,
  type RunFile,
} from '../eval-vision-lib';
import type { LlmCompletionRequest, LlmDriver } from '../../src/ai';

const LIMITS = { maxPages: 50, maxOutputTokens: 32768, maxFileBytes: 50_000_000 };

describe('parseArgs', () => {
  it('needs a mode and a fixtures directory', () => {
    expect(() => parseArgs([], {})).toThrow(/"run" or "score"/);
    expect(() => parseArgs(['run', '--plan'], {})).toThrow(/--fixtures/);
    expect(parseArgs(['run', '--plan', '--fixtures', '/x'], {}).plan).toBe(true);
    expect(parseArgs(['run', '--plan'], { EVAL_VISION_FIXTURES: '/y' }).fixtures).toBe('/y');
  });

  it('refuses a paid run without a cap and an output directory, but not a plan', () => {
    expect(() => parseArgs(['run', '--fixtures', '/x', '--out', '/o'], {})).toThrow(/--max-usd/);
    expect(() => parseArgs(['run', '--fixtures', '/x', '--max-usd', '1'], {})).toThrow(/--out/);
    expect(parseArgs(['run', '--fixtures', '/x', '--max-usd', '1', '--out', '/o'], {}).maxUsd).toBe(
      1,
    );
  });

  it('takes an optional prompt template file, so a prompt can be tried before it is in the database', () => {
    expect(parseArgs(['run', '--plan', '--fixtures', '/x'], {}).presetFile).toBeNull();
    expect(
      parseArgs(['run', '--plan', '--fixtures', '/x', '--preset-file', '/p.txt'], {}).presetFile,
    ).toBe('/p.txt');
  });

  it('is strict: unknown flags, missing values and bad numbers all throw', () => {
    expect(() => parseArgs(['run', '--fixtures', '/x', '--plan', '--force'], {})).toThrow(
      /unknown/,
    );
    expect(() => parseArgs(['run', '--fixtures'], {})).toThrow(/needs a value/);
    expect(() =>
      parseArgs(['run', '--fixtures', '/x', '--max-usd', '0', '--out', '/o'], {}),
    ).toThrow(/positive/);
    expect(() => parseArgs(['run', '--fixtures', '/x', '--plan', '--limit', '1.5'], {})).toThrow(
      /integer/,
    );
    expect(() => parseArgs(['score', '--fixtures', '/x'], {})).toThrow(/--run/);
  });
});

describe('planVision', () => {
  it('prices both vision arms from pages and text length: two calls per file, no call made, only arithmetic', () => {
    const p = planVision([{ id: 'a', bytes: 1000, pages: 9, textChars: 8000 }], LIMITS);
    expect(p.calls).toBe(2);
    // Pages alone: 300 + 525 x 9 input tokens; with the text layer, 0.25 token per character more.
    expect(p.rows[0]!.inputTokens).toBe(5025);
    expect(p.rows[0]!.inputTokensWithText).toBe(5025 + 2000);
    // Both at 358 x 9 output tokens, $1.50 / $9.00 per 1M.
    const out = 358 * 9 * 9;
    expect(p.expectedUsd).toBeCloseTo((5025 * 1.5 + out + (7025 * 1.5 + out)) / 1e6, 6);
    // Worst: the whole 32,768-token output allowance, on each arm.
    expect(p.worstUsd).toBeCloseTo((5025 * 1.5 + 32768 * 9 + (7025 * 1.5 + 32768 * 9)) / 1e6, 6);
  });

  it('an image-only PDF (no text layer) costs the same on both arms', () => {
    const p = planVision([{ id: 'a', bytes: 1000, pages: 4, textChars: 0 }], LIMITS);
    expect(p.rows[0]!.inputTokensWithText).toBe(p.rows[0]!.inputTokens);
  });

  it('leaves out what the caps keep on the text layer, as the scan core would', () => {
    const p = planVision(
      [
        { id: 'ok', bytes: 1000, pages: 50, textChars: 0 },
        { id: 'long', bytes: 1000, pages: 51, textChars: 0 },
        { id: 'big', bytes: LIMITS.maxFileBytes + 1, pages: 3, textChars: 0 },
      ],
      LIMITS,
    );
    expect(p.rows.map((r) => r.eligible)).toEqual([true, false, false]);
    expect(p.calls).toBe(2);
    expect(p.skipped).toBe(2);
  });

  it('assumes the page cap for a PDF whose pages could not be counted', () => {
    const p = planVision([{ id: 'x', bytes: 10, pages: null, textChars: 0 }], LIMITS);
    expect(p.rows[0]!.inputTokens).toBe(300 + 525 * 50);
  });
});

describe('scoreText', () => {
  const gold = { must_include: ['Alpha plan', 'beta  budget'], must_not_include: ['gamma'] };
  it('ignores case and spacing, and lists what is missing or forbidden', () => {
    expect(scoreText('the ALPHA   plan and the beta budget', gold)).toEqual({
      recall: 1,
      missing: [],
      forbidden: [],
    });
    expect(scoreText('only alpha plan, plus gamma', gold)).toEqual({
      recall: 0.5,
      missing: ['beta  budget'],
      forbidden: ['gamma'],
    });
  });
  it('has no recall to report when the gold lists no facts', () => {
    expect(scoreText('anything', { must_include: [], must_not_include: [] }).recall).toBeNull();
  });
});

describe('loadFixtures', () => {
  const make = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-vision-test-'));
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
    return dir;
  };
  it('pairs each PDF with its gold file, an empty gold when there is none', () => {
    const dir = make({ 'a.pdf': '%PDF', 'a.gold.json': '{"must_include":["x"]}', 'b.pdf': '%PDF' });
    const fx = loadFixtures(dir);
    expect(fx.map((f) => [f.id, f.gold.must_include])).toEqual([
      ['a', ['x']],
      ['b', []],
    ]);
  });
  it('refuses a gold file with no PDF, an unknown key, and a directory without PDFs', () => {
    expect(() => loadFixtures(make({ 'a.gold.json': '{}' }))).toThrow(/no \*\.pdf/);
    expect(() => loadFixtures(make({ 'b.pdf': 'x', 'a.gold.json': '{}' }))).toThrow(/has no PDF/);
    expect(() => loadFixtures(make({ 'a.pdf': 'x', 'a.gold.json': '{"oops":1}' }))).toThrow(
      /a\.gold\.json/,
    );
  });
});

describe('guardMediaDriver', () => {
  const fake = (usage?: object): LlmDriver => ({
    name: 'fake',
    complete: async (req: LlmCompletionRequest) => ({
      text: 'ok',
      driver: 'fake',
      model: req.model,
      ...(usage ? { usage: usage as never } : {}),
    }),
  });
  const REQ: LlmCompletionRequest = {
    model: 'm',
    temperature: 0,
    prompt: 'p',
    maxOutputTokens: 1000,
  };

  it('counts the media tokens in the worst case, which req.prompt cannot show', async () => {
    const calls: CallRecord[] = [];
    const llm = fake();
    // 1M input tokens alone is $1.50: over a $1 cap although the prompt text is one word.
    guardMediaDriver(llm, new Budget(1), calls, false, () => 1_000_000);
    await expect(llm.complete(REQ)).rejects.toBeInstanceOf(BudgetStop);
    expect(calls).toEqual([]);
  });

  it('charges the reported usage on success and the worst case of every attempt on failure', async () => {
    const calls: CallRecord[] = [];
    const budget = new Budget(10);
    const llm = fake({
      promptTokens: 1000,
      outputTokens: 100,
      thoughtsTokens: 0,
      totalTokens: 1100,
    });
    guardMediaDriver(llm, budget, calls, false, () => 1000);
    await llm.complete(REQ);
    expect(budget.spentUsd).toBeCloseTo((1000 * 1.5 + 100 * 9) / 1e6, 8);

    const failing: LlmDriver = { name: 'f', complete: async () => Promise.reject(new Error('x')) };
    const b2 = new Budget(10);
    guardMediaDriver(failing, b2, [], false, () => 1000);
    await expect(failing.complete(REQ)).rejects.toThrow('x');
    expect(b2.spentUsd).toBeCloseTo(((1000 * 1.5 + 1000 * 9) / 1e6) * 3, 8);
  });

  it('charges nothing for the mock driver', async () => {
    const budget = new Budget(0.0001);
    const llm = fake();
    guardMediaDriver(llm, budget, [], true, () => 9_999_999);
    await llm.complete(REQ);
    expect(budget.spentUsd).toBe(0);
  });
});

describe('rescore and the report', () => {
  const arm = (text: string): ArmResult => ({
    chars: text.length,
    text,
    score: { recall: null, missing: [], forbidden: [] },
    error: null,
    usd: 0.01,
    promptTokens: 10,
    outputTokens: 5,
    thoughtsTokens: 0,
    latencyMs: 7,
  });
  const run: RunFile = {
    version: 2,
    kind: 'eval-vision-run',
    startedAt: 't',
    finishedAt: 't',
    driver: 'd',
    model: 'm',
    maxUsd: 1,
    spentUsd: 0.01,
    stoppedByBudget: null,
    files: [
      {
        id: 'a',
        bytes: 1,
        pages: 2,
        textLayer: arm('alpha'),
        visionPages: arm('alpha'),
        visionPagesText: arm('alpha beta'),
      },
    ],
  };

  it('re-scores both arms against a corrected gold without a model call', () => {
    const fixtures = [
      {
        id: 'a',
        file: '/x',
        bytes: 1,
        gold: { must_include: ['alpha', 'beta'], must_not_include: [] },
      },
    ];
    const again = rescore(run, fixtures);
    expect(again.files[0]!.textLayer.score.recall).toBe(0.5);
    expect(again.files[0]!.visionPages!.score.recall).toBe(0.5);
    expect(again.files[0]!.visionPagesText!.score.recall).toBe(1);
    expect(isRunFile(again)).toBe(true);
    expect(isRunFile({ kind: 'eval-ideas-run' })).toBe(false);
  });

  it('prints ids and numbers, never the transcription', () => {
    const text = formatReport(rescore(run, []));
    expect(text).toContain('a  2p');
    expect(text).not.toContain('alpha');
  });

  it('scores pages alone against pages plus text, and says which recalled more', () => {
    const fixtures = [
      {
        id: 'a',
        file: '/x',
        bytes: 1,
        gold: { must_include: ['alpha', 'beta'], must_not_include: [] },
      },
    ];
    const text = formatReport(rescore(run, fixtures));
    expect(text).toContain('vision pages:');
    expect(text).toContain('vision pages+text:');
    expect(text).toContain('mean recall: text layer 50%, vision pages 50%, vision pages+text 100%');
    expect(text).toContain('vision pages total $0.0100, pages+text total $0.0100');
  });

  it('an arm that errored or never ran does not count toward the mean recall', () => {
    const failed = { ...arm(''), error: 'boom' };
    const text = formatReport(
      rescore(
        {
          ...run,
          files: [{ ...run.files[0]!, visionPages: failed, visionPagesText: null }],
        },
        [
          {
            id: 'a',
            file: '/x',
            bytes: 1,
            gold: { must_include: ['alpha'], must_not_include: [] },
          },
        ],
      ),
    );
    expect(text).toContain('vision pages n/a, vision pages+text n/a');
    expect(text).toContain('error boom');
  });

  it('refuses a version-1 run file (one arm), which this report cannot compare', () => {
    expect(isRunFile({ ...run, version: 1 })).toBe(false);
  });
});
