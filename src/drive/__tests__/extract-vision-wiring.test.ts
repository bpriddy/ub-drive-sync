/**
 * extractText with { vision: 'pdf' }: where vision sits (the upload and the text
 * layer inside the download reservation, which stays the file's own size; the
 * model call after the reservation is released), what the model is sent (the
 * staged gs:// part and the text layer), what the text layer still answers
 * after a failure, and that nothing changes without the flag or without the
 * option. The model runner, the preset row and the staging bucket are mocks;
 * the Drive download is faked; unpdf is the real one on a synthetic PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ApiError } from '@google/genai';

const { downloadMock, runLoaded, loadPreset, stagePdf, llm, cfg } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  runLoaded: vi.fn(),
  loadPreset: vi.fn(),
  stagePdf: vi.fn(),
  llm: { name: 'gemini-enterprise' },
  cfg: {
    DRIVE_MAX_FILE_SIZE_BYTES: 26214400,
    DOWNLOAD_INFLIGHT_BYTES: 100_000,
    DOWNLOAD_HEAVY_BYTES: 60_000,
    DRIVE_VISION_PDF: 'on',
    DRIVE_VISION_STAGING_BUCKET: 'stage-bucket',
    DRIVE_VISION_MAX_FILE_SIZE_BYTES: 20_000,
    DRIVE_VISION_MAX_PDF_PAGES: 5,
    DRIVE_VISION_MAX_OUTPUT_TOKENS: 4096,
    GEMINI_TIMEOUT_VISION_MS: 1000,
    GEMINI_THINKING_BY_TAG: {},
  },
}));

vi.mock('googleapis', () => ({
  google: { docs: vi.fn(), slides: vi.fn(), sheets: vi.fn(), drive: vi.fn(() => ({})) },
}));
vi.mock('../../workspace', () => ({ buildBotOAuthClient: vi.fn() }));
vi.mock('../../config', () => ({ config: cfg }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../client', () => ({ downloadFileBuffer: downloadMock }));
vi.mock('../../ai', () => ({ defaultLlm: llm, loadPreset, runLoadedPreset: runLoaded }));
vi.mock('../vision-staging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vision-staging')>()),
  stagePdf,
}));

import { downloadBudget } from '../download';
import { extractText, predictExtractionSkip } from '../extract';
import { LlmTimeoutError } from '../../ai/retryable';
import type { TraversedFile } from '../types';
import { buildPdf } from './synthetic-pdf';

const PHRASE = 'Quarterly status for Acme';
const PDF = buildPdf([PHRASE]);
const PRESET = { key: 'drive.vision_extraction.v1', template: 't', model: 'm', temperature: 0 };
const STAGED_URI = 'gs://stage-bucket/vision/22222222-2222-4222-8222-222222222222.pdf';

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

/** Download-budget bytes reserved at the moment of each event. */
let reservedAtDownload: number[];
let reservedAtUpload: number[];
let reservedAtCall: number[];
const remove = vi.fn();

beforeEach(() => {
  cfg.DRIVE_VISION_PDF = 'on';
  cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 20_000;
  llm.name = 'gemini-enterprise';
  reservedAtDownload = [];
  reservedAtUpload = [];
  reservedAtCall = [];
  downloadMock.mockReset();
  downloadMock.mockImplementation(async () => {
    reservedAtDownload.push(downloadBudget().inFlightBytes);
    return Buffer.from(PDF);
  });
  loadPreset.mockReset().mockResolvedValue(PRESET);
  remove.mockReset().mockResolvedValue(undefined);
  stagePdf.mockReset();
  stagePdf.mockImplementation(async () => {
    reservedAtUpload.push(downloadBudget().inFlightBytes);
    return { uri: STAGED_URI, remove };
  });
  runLoaded.mockReset();
  runLoaded.mockImplementation(async () => {
    reservedAtCall.push(downloadBudget().inFlightBytes);
    return { text: '# T\n\n## Page 1\nvision text', model: 'm' };
  });
});

describe('extractText with vision', () => {
  it('returns the transcription as extractor "vision": the file reserved at its own size, the call holding none', async () => {
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ kind: 'ok', extractor: 'vision' });
    expect(out.kind === 'ok' && out.text).toContain('vision text');
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(runLoaded).toHaveBeenCalledTimes(1);
    // No 4x reservation; the upload is inside the file's own reservation, and
    // the model call is outside every reservation.
    expect(reservedAtDownload).toEqual([PDF.length]);
    expect(reservedAtUpload).toEqual([PDF.length]);
    expect(reservedAtCall).toEqual([0]);
    expect(downloadBudget().inFlightBytes).toBe(0);
  });

  it('sends the staged gs:// part and the PDF text layer in one request, then deletes the object', async () => {
    await extractText(pdfFile(), { vision: 'pdf' });
    const [preset, opts] = runLoaded.mock.calls[0]!;
    expect(preset).toBe(PRESET);
    expect(opts.mediaRefs).toEqual([{ mimeType: 'application/pdf', fileUri: STAGED_URI }]);
    expect(opts.variables.text_layer).toContain(PHRASE);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('sends an empty text layer for an image-only PDF', async () => {
    const imageOnly = buildPdf(['']);
    downloadMock.mockImplementation(async () => Buffer.from(imageOnly));
    const out = await extractText(pdfFile({ size: imageOnly.length }), { vision: 'pdf' });
    expect(out).toMatchObject({ kind: 'ok', extractor: 'vision' });
    expect(runLoaded.mock.calls[0]![1].variables.text_layer.trim()).toBe('');
  });

  it('falls back to the text layer after a permanent failure, and still deletes the object', async () => {
    runLoaded.mockRejectedValue(new ApiError({ message: 'bad', status: 400 }));
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ kind: 'ok', extractor: 'pdf', visionFallback: 'api_error' });
    expect(out.kind === 'ok' && out.text).toContain(PHRASE);
    expect(out.kind === 'ok' && out.degraded).toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('marks a transient failure degraded, with the text layer as the stand-in', async () => {
    runLoaded.mockRejectedValue(new LlmTimeoutError(1000));
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({
      kind: 'ok',
      extractor: 'pdf',
      visionFallback: 'transient_error',
      degraded: true,
    });
    expect(out.kind === 'ok' && out.text).toContain(PHRASE);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('falls back on an empty transcription without a stub row', async () => {
    runLoaded.mockResolvedValue({ text: '  ', model: 'm' });
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ extractor: 'pdf', visionFallback: 'empty_transcription' });
  });

  it('a missing or inactive preset never fails the file: the text layer answers, degraded, nothing uploaded', async () => {
    loadPreset.mockRejectedValue(
      new Error('[prompt-preset] preset drive.vision_extraction.v1 is inactive'),
    );
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({
      kind: 'ok',
      extractor: 'pdf',
      visionFallback: 'preset_unavailable',
      degraded: true,
    });
    expect(out.kind === 'ok' && out.text).toContain(PHRASE);
    expect(stagePdf).not.toHaveBeenCalled();
    expect(runLoaded).not.toHaveBeenCalled();
  });

  it('a failed upload never fails the file: the text layer answers, degraded, no model call', async () => {
    stagePdf.mockRejectedValue(new Error('upload failed'));
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({
      kind: 'ok',
      extractor: 'pdf',
      visionFallback: 'staging_failed',
      degraded: true,
    });
    expect(runLoaded).not.toHaveBeenCalled();
  });

  it('a PDF the parser cannot read still reaches vision, and fails the file only if vision does not answer', async () => {
    downloadMock.mockImplementation(async () => Buffer.from('not a pdf at all'));
    const ok = await extractText(pdfFile({ size: 16 }), { vision: 'pdf' });
    expect(ok).toMatchObject({ kind: 'ok', extractor: 'vision' });
    expect(runLoaded.mock.calls[0]![1].variables.text_layer).toBe('');

    runLoaded.mockRejectedValue(new ApiError({ message: 'bad', status: 400 }));
    await expect(extractText(pdfFile({ size: 16 }), { vision: 'pdf' })).rejects.toThrow();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("decides from metadata before downloading: over the cap keeps today's path, nothing staged", async () => {
    cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = PDF.length - 1;
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ extractor: 'pdf' });
    expect(out.kind === 'ok' && out.visionFallback).toBeUndefined();
    expect(stagePdf).not.toHaveBeenCalled();
    expect(runLoaded).not.toHaveBeenCalled();
  });

  it('does not try vision for a file of unknown size', async () => {
    const out = await extractText(pdfFile({ size: null }), { vision: 'pdf' });
    expect(out).toMatchObject({ extractor: 'pdf' });
    expect(stagePdf).not.toHaveBeenCalled();
    expect(runLoaded).not.toHaveBeenCalled();
  });
});

describe('extractText without vision: nothing changes', () => {
  it('no option: no model call, no upload, today\'s reservation (the file size), extractor "pdf"', async () => {
    const out = await extractText(pdfFile());
    expect(out).toMatchObject({ kind: 'ok', extractor: 'pdf' });
    expect(out.kind === 'ok' && Object.keys(out).sort()).toEqual([
      'contentHash',
      'extractor',
      'kind',
      'text',
    ]);
    expect(runLoaded).not.toHaveBeenCalled();
    expect(stagePdf).not.toHaveBeenCalled();
    expect(loadPreset).not.toHaveBeenCalled();
    expect(reservedAtDownload).toEqual([PDF.length]);
  });

  it('flag off, option given: no model call, no upload and the same result shape', async () => {
    cfg.DRIVE_VISION_PDF = 'off';
    const out = await extractText(pdfFile(), { vision: 'pdf' });
    expect(out).toMatchObject({ kind: 'ok', extractor: 'pdf' });
    expect(runLoaded).not.toHaveBeenCalled();
    expect(stagePdf).not.toHaveBeenCalled();
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

describe('a vision PDF no longer pauses other downloads for the length of the model call', () => {
  it('a heavy PDF (at or above the heavy threshold) is admitted at its own size, and a second download starts while its model call is still in flight', async () => {
    cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 80_000;
    const heavy = 61_000; // above DOWNLOAD_HEAVY_BYTES (60 KB): runs alone while it downloads
    const big = Buffer.alloc(heavy, 1);
    downloadMock.mockImplementation(async () => big);
    let releaseCall!: () => void;
    const gate = new Promise<void>((r) => (releaseCall = r));
    runLoaded.mockImplementationOnce(async () => {
      await gate; // the first model call stays in flight
      return { text: '## Page 1\nx', model: 'm' };
    });
    const first = extractText(pdfFile({ id: 'big-1', size: heavy }), { vision: 'pdf' });
    // Wait until the first call is in flight (its reservation is released by then).
    await vi.waitFor(() => expect(runLoaded).toHaveBeenCalledTimes(1));
    expect(downloadBudget().inFlightBytes).toBe(0);
    // A second file downloads and reaches its own model call before the first one ends.
    const second = await extractText(pdfFile({ id: 'big-2', size: heavy }), { vision: 'pdf' });
    expect(second).toMatchObject({ kind: 'ok', extractor: 'vision' });
    expect(downloadMock).toHaveBeenCalledTimes(2);
    releaseCall();
    expect(await first).toMatchObject({ kind: 'ok', extractor: 'vision' });
    expect(downloadBudget().inFlightBytes).toBe(0);
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
