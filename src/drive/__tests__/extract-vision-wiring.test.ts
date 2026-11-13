/**
 * extractText with { vision: 'pdf' }: where vision sits (inside the download
 * byte reservation, which it enlarges), what the text layer still gets after
 * it, and that nothing changes without the flag or without the option. The
 * Gemini client is a mock; the Drive download is faked; unpdf is the real one
 * on a synthetic PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ApiError } from '@google/genai';

const { downloadMock, complete, llm, cfg } = vi.hoisted(() => {
  const complete = vi.fn();
  return {
    downloadMock: vi.fn(),
    complete,
    llm: { name: 'gemini-enterprise', complete },
    cfg: {
      DRIVE_MAX_FILE_SIZE_BYTES: 26214400,
      DOWNLOAD_INFLIGHT_BYTES: 100_000,
      DOWNLOAD_HEAVY_BYTES: 60_000,
      DRIVE_VISION_PDF: 'on',
      DRIVE_VISION_MAX_FILE_SIZE_BYTES: 20_000,
      DRIVE_VISION_MAX_PDF_PAGES: 5,
      DRIVE_VISION_MAX_OUTPUT_TOKENS: 4096,
      GEMINI_TIMEOUT_VISION_MS: 1000,
      GEMINI_THINKING_BY_TAG: {},
    },
  };
});

vi.mock('googleapis', () => ({
  google: { docs: vi.fn(), slides: vi.fn(), sheets: vi.fn(), drive: vi.fn(() => ({})) },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../config', () => ({ config: cfg }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../client', () => ({ downloadFileBuffer: downloadMock }));
vi.mock('../../ai', () => ({ defaultLlm: llm, DEFAULT_GEMINI_MODEL: 'test-model' }));

import { downloadBudget } from '../download';
import { extractText, predictExtractionSkip } from '../extract';
import { LlmTimeoutError } from '../../ai/retryable';
import type { TraversedFile } from '../types';
import { buildPdf } from './synthetic-pdf';

const PHRASE = 'Quarterly status for Acme';
const PDF = buildPdf([PHRASE]);

const pdfFile = (over: Partial<TraversedFile> = {}): TraversedFile => ({
  id: 'file-1',
  name: 'Acme status',
  mimeType: 'application/pdf',
  path: 'Acme / Status',
  modifiedTime: null,
  modifiedByEmail: null,
  createdTime: null,
  size: PDF.length,
  isFolder: false,
  ...over,
});

/** Reserved bytes at the moment the model is called. */
let reservedAtCall: number[];

beforeEach(() => {
  cfg.DRIVE_VISION_PDF = 'on';
  cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 20_000;
  downloadMock.mockReset();
  downloadMock.mockImplementation(async () => Buffer.from(PDF));
  complete.mockReset();
  reservedAtCall = [];
  complete.mockImplementation(async () => {
    reservedAtCall.push(downloadBudget().inFlightBytes);
    return { text: '# T\n\n## Page 1\nvision text', model: 'm' };
  });
});

describe('extractText with vision', () => {
  it('returns the transcription as extractor "vision", holding 4x the file in the budget', async () => {
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ kind: 'ok', extractor: 'vision' });
    expect(out.kind === 'ok' && out.text).toContain('vision text');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(reservedAtCall).toEqual([PDF.length * 4]);
    expect(downloadBudget().inFlightBytes).toBe(0); // released after
  });

  it('falls back to the text layer after a permanent failure, which can still read the bytes', async () => {
    complete.mockRejectedValue(new ApiError({ message: 'bad', status: 400 }));
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ kind: 'ok', extractor: 'pdf', visionFallback: 'api_error' });
    expect(out.kind === 'ok' && out.text).toContain(PHRASE);
    expect(out.kind === 'ok' && out.degraded).toBeUndefined();
  });

  it('marks a transient failure degraded, with the text layer as the stand-in', async () => {
    complete.mockRejectedValue(new LlmTimeoutError(1000));
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({
      kind: 'ok',
      extractor: 'pdf',
      visionFallback: 'transient_error',
      degraded: true,
    });
    expect(out.kind === 'ok' && out.text).toContain(PHRASE);
  });

  it('falls back on an empty transcription without a stub row', async () => {
    complete.mockResolvedValue({ text: '  ', model: 'm' });
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ extractor: 'pdf', visionFallback: 'empty_transcription' });
  });

  it("decides from metadata before downloading: over the cap keeps today's path and reservation", async () => {
    cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = PDF.length - 1;
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ extractor: 'pdf' });
    expect(out.kind === 'ok' && out.visionFallback).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not try vision for a file of unknown size', async () => {
    const out = await extractText(pdfFile({ size: null }), { vision: 'pdf' });
    expect(out).toMatchObject({ extractor: 'pdf' });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('extractText without vision: nothing changes', () => {
  it('no option: no model call, today\'s reservation (the file size), extractor "pdf"', async () => {
    const seen: number[] = [];
    downloadMock.mockImplementation(async () => {
      seen.push(downloadBudget().inFlightBytes);
      return Buffer.from(PDF);
    });
    const out = await extractText(pdfFile());
    expect(out).toMatchObject({ kind: 'ok', extractor: 'pdf' });
    expect(out.kind === 'ok' && Object.keys(out).sort()).toEqual([
      'contentHash',
      'extractor',
      'kind',
      'text',
    ]);
    expect(complete).not.toHaveBeenCalled();
    expect(seen).toEqual([PDF.length]);
  });

  it('flag off, option given: no model call and the same result shape', async () => {
    cfg.DRIVE_VISION_PDF = 'off';
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ kind: 'ok', extractor: 'pdf' });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('lockstep with predictExtractionSkip', () => {
  const cases: Array<[string, TraversedFile]> = [
    ['an ordinary PDF', pdfFile()],
    ['a PDF over the download cap', pdfFile({ size: 26214400 + 1 })],
    ['a PDF of unknown size', pdfFile({ size: null })],
    [
      'a shortcut to a PDF (target size unknown)',
      pdfFile({
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTarget: { id: 't', mimeType: 'application/pdf' },
      }),
    ],
    ['a PDF at the vision cap', pdfFile({ size: 20_000 })],
    ['a PDF one over the vision cap', pdfFile({ size: 20_001 })],
  ];
  it.each(cases)('vision never produces a skip the predictor misses: %s', async (_n, file) => {
    cfg.DRIVE_VISION_PDF = 'off';
    const off = predictExtractionSkip(file);
    cfg.DRIVE_VISION_PDF = 'on';
    expect(predictExtractionSkip(file)).toEqual(off);
    if (off === null) {
      const out = await extractText(file, { vision: 'pdf' });
      expect(out.kind).toBe('ok');
    } else {
      expect(await extractText(file, { vision: 'pdf' })).toEqual(off);
    }
  });
});

describe('four vision PDFs at once stay inside the byte budget', () => {
  it('the 4x reservation bounds the bytes in flight, however many workers ask', async () => {
    const size = 14_000; // 56 KB reserved each: under HEAVY (60 KB), two fit in 100 KB
    const big = Buffer.alloc(size, 1);
    downloadMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return big;
    });
    complete.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { text: '## Page 1\nx', model: 'm' };
    });
    cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 20_000;
    const files = Array.from({ length: 4 }, (_, i) => pdfFile({ id: `big-${i}`, size }));
    const outs = await Promise.all(files.map((f) => extractText(f, { vision: 'pdf' })));
    expect(outs.every((o) => o.kind === 'ok' && o.extractor === 'vision')).toBe(true);
    const budget = downloadBudget();
    expect(budget.highWaterBytes).toBeLessThanOrEqual(budget.capacityBytes);
    expect(budget.highWaterActive).toBe(1); // 56 KB x 2 > 100 KB capacity: one at a time
    expect(budget.inFlightBytes).toBe(0);
  });
});

describe('only the scan core asks for vision', () => {
  it('no other caller of extractText passes an option', () => {
    const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
    for (const p of ['../sync.ts', '../discover.ts', '../idea-runner.ts']) {
      const calls = read(p).match(/extractText\([^)]*\)/g) ?? [];
      expect(calls.length, p).toBeGreaterThan(0);
      for (const c of calls) expect(c, p).not.toContain(',');
    }
    expect(read('../../scan/process-batch.ts')).toMatch(/extractText\(file, \{ vision: 'pdf' \}\)/);
  });
});
