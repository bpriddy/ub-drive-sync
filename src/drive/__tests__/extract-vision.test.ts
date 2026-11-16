/**
 * prepareVisionPdf / transcribeStagedPdf / visionExtractPdf: the gates, the
 * preset, the staging and its cleanup, the failure classes, the request they
 * build (a Cloud Storage reference plus the text layer), and the page count's
 * bounded copy. The model client, the preset row and the staging bucket are
 * mocks (no model call, no database, no storage call of any kind); unpdf is
 * real, run on a synthetic PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@google/genai';

const { runLoaded, loadPreset, llm, cfg, logs, destroyed } = vi.hoisted(() => {
  const runLoaded = vi.fn();
  return {
    runLoaded,
    loadPreset: vi.fn(),
    llm: { name: 'gemini-enterprise' },
    cfg: {
      DRIVE_VISION_MAX_FILE_SIZE_BYTES: 14 * 1024 * 1024,
      DRIVE_VISION_MAX_PDF_PAGES: 2,
      DRIVE_VISION_MAX_OUTPUT_TOKENS: 4096,
      GEMINI_TIMEOUT_VISION_MS: 777,
      GEMINI_THINKING_BY_TAG: {} as Record<string, string>,
    },
    logs: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    destroyed: { count: 0 },
  };
});

vi.mock('../../config', () => ({ config: cfg }));
vi.mock('../../logger', () => ({ logger: logs }));
vi.mock('../../ai', () => ({
  defaultLlm: llm,
  loadPreset,
  runLoadedPreset: runLoaded,
}));
vi.mock('unpdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('unpdf')>();
  return {
    ...actual,
    getDocumentProxy: (data: Uint8Array, options?: Parameters<typeof actual.getDocumentProxy>[1]) =>
      actual.getDocumentProxy(data, options).then((pdf) => {
        const destroy = pdf.destroy.bind(pdf);
        pdf.destroy = async () => {
          destroyed.count++;
          return destroy();
        };
        return pdf;
      }),
  };
});

import { LlmTimeoutError, LlmTruncatedError } from '../../ai/retryable';
import {
  countPdfPages,
  prepareVisionPdf,
  transcribeStagedPdf,
  visionExtractPdf,
  VISION_PRESET_KEY,
  VISION_TAG,
  type PreparedVision,
} from '../extract-vision';
import type { PdfStager } from '../vision-staging';
import { buildPdf } from './synthetic-pdf';

const FILE = { id: 'file-1' };
const PRESET = { key: VISION_PRESET_KEY, template: 'T {{text_layer}}', model: 'm', temperature: 0 };
const STAGED_URI = 'gs://stage-bucket/vision/11111111-1111-4111-8111-111111111111.pdf';
const pdfBuf = (pages = 1): Buffer =>
  Buffer.from(buildPdf(Array.from({ length: pages }, (_, i) => `page ${i + 1}`)));
const SECRET_TRANSCRIPTION = 'synthetic transcription body ZXQ-91';
const SECRET_LAYER = 'synthetic text layer body QWV-17';

const remove = vi.fn();
const stage = vi.fn<PdfStager>();

/** A prepared PDF, as prepareVisionPdf returns it. */
async function prepared(buf = pdfBuf()): Promise<PreparedVision> {
  const prep = await prepareVisionPdf(FILE, buf, stage);
  if (!('prepared' in prep)) throw new Error(`not prepared: ${prep.fallback}`);
  return prep.prepared;
}

beforeEach(() => {
  runLoaded.mockReset();
  runLoaded.mockResolvedValue({ text: `# T\n\n## Page 1\n${SECRET_TRANSCRIPTION}`, model: 'm' });
  loadPreset.mockReset();
  loadPreset.mockResolvedValue(PRESET);
  remove.mockReset().mockResolvedValue(undefined);
  stage.mockReset().mockResolvedValue({ uri: STAGED_URI, remove });
  llm.name = 'gemini-enterprise';
  cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 14 * 1024 * 1024;
  cfg.DRIVE_VISION_MAX_PDF_PAGES = 2;
  cfg.GEMINI_THINKING_BY_TAG = {};
  destroyed.count = 0;
  for (const fn of Object.values(logs)) fn.mockReset();
});

describe('the request: a Cloud Storage reference and the text layer, through the preset', () => {
  it('stages the bytes once, loads the vision preset, and sends the gs:// part with the layer', async () => {
    const buf = pdfBuf();
    const p = await prepared(buf);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0]![0]).toBe(buf);
    expect(loadPreset).toHaveBeenCalledWith('drive.vision_extraction.v1');

    const out = await transcribeStagedPdf(FILE, p, SECRET_LAYER);
    expect(out).toEqual({ text: expect.stringContaining(SECRET_TRANSCRIPTION) });
    expect(runLoaded).toHaveBeenCalledTimes(1);
    const [preset, opts] = runLoaded.mock.calls[0]!;
    expect(preset).toBe(PRESET);
    expect(opts).toEqual({
      key: 'drive.vision_extraction.v1',
      variables: { text_layer: SECRET_LAYER },
      mediaRefs: [{ mimeType: 'application/pdf', fileUri: STAGED_URI }],
      maxOutputTokens: 4096,
      thinkingLevel: 'MINIMAL',
      timeoutMs: 777,
    });
    // By reference only: no inline bytes anywhere in what the preset runner gets.
    expect(JSON.stringify(opts)).not.toContain(buf.toString('base64').slice(0, 40));
    expect(VISION_TAG).toBe('drive.vision_extraction.v1');
  });

  it('sends an empty text layer for an image-only PDF', async () => {
    await transcribeStagedPdf(FILE, await prepared(), '');
    expect(runLoaded.mock.calls[0]![1].variables).toEqual({ text_layer: '' });
  });

  it('lets GEMINI_THINKING_BY_TAG set the level for the vision call type', async () => {
    cfg.GEMINI_THINKING_BY_TAG = { vision: 'LOW' };
    await transcribeStagedPdf(FILE, await prepared(), '');
    expect(runLoaded.mock.calls[0]![1].thinkingLevel).toBe('LOW');
  });
});

describe('gates fall back without a model call or an upload', () => {
  it.each(['mock', 'gemini'])('refuses the %s driver', async (name) => {
    llm.name = name;
    expect(await prepareVisionPdf(FILE, pdfBuf(), stage)).toEqual({
      fallback: 'driver_not_enterprise',
      transient: false,
    });
    expect(stage).not.toHaveBeenCalled();
    expect(loadPreset).not.toHaveBeenCalled();
  });

  it('refuses bytes over the size cap, checked on what was received', async () => {
    cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 10;
    expect(await prepareVisionPdf(FILE, pdfBuf(), stage)).toEqual({
      fallback: 'over_size_cap',
      transient: false,
    });
    expect(stage).not.toHaveBeenCalled();
  });

  it('refuses a PDF over the page cap, and accepts one exactly at it', async () => {
    expect(await prepareVisionPdf(FILE, pdfBuf(3), stage)).toEqual({
      fallback: 'over_page_cap',
      transient: false,
    });
    expect(stage).not.toHaveBeenCalled();
    expect(await prepareVisionPdf(FILE, pdfBuf(2), stage)).toHaveProperty('prepared');
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('still tries vision when the parser cannot open the file (page count unknown)', async () => {
    const out = await prepareVisionPdf(FILE, Buffer.from('not a pdf at all'), stage);
    expect(out).toHaveProperty('prepared');
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', new Error('[prompt-preset] no preset found with key=drive.vision_extraction.v1')],
    ['inactive', new Error('[prompt-preset] preset drive.vision_extraction.v1 is inactive')],
    ['unreachable', new Error('connect ECONNREFUSED')],
  ])(
    'a %s preset falls back to the text layer, transient, and never throws or uploads',
    async (_n, err) => {
      loadPreset.mockRejectedValue(err);
      await expect(prepareVisionPdf(FILE, pdfBuf(), stage)).resolves.toEqual({
        fallback: 'preset_unavailable',
        transient: true,
      });
      expect(stage).not.toHaveBeenCalled();
      expect(runLoaded).not.toHaveBeenCalled();
      expect(logs.warn).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'file-1', reason: 'preset_unavailable' }),
        expect.stringContaining('vision_failed'),
      );
    },
  );

  it('a failed upload falls back to the text layer, transient, with no model call', async () => {
    stage.mockRejectedValue(
      Object.assign(new Error('quota exceeded for gs://stage-bucket/vision/x.pdf'), { code: 403 }),
    );
    await expect(prepareVisionPdf(FILE, pdfBuf(), stage)).resolves.toEqual({
      fallback: 'staging_failed',
      transient: true,
    });
    expect(runLoaded).not.toHaveBeenCalled();
    // The error text can quote the object path: only its class and code are logged.
    const everything = JSON.stringify(logs.warn.mock.calls);
    expect(everything).not.toContain('stage-bucket');
    expect(everything).toContain('403');
  });
});

describe('the staged object is deleted after the call, whatever its outcome', () => {
  it('on success', async () => {
    const p = await prepared();
    expect(remove).not.toHaveBeenCalled();
    await transcribeStagedPdf(FILE, p, 'layer');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  const cases: Array<[string, unknown, { fallback: string; transient: boolean }]> = [
    [
      'a 400',
      new ApiError({ message: 'bad', status: 400 }),
      { fallback: 'api_error', transient: false },
    ],
    [
      'a 403',
      new ApiError({ message: 'no', status: 403 }),
      { fallback: 'api_error', transient: false },
    ],
    [
      'a 429',
      new ApiError({ message: 'slow', status: 429 }),
      { fallback: 'transient_error', transient: true },
    ],
    [
      'a 503',
      new ApiError({ message: 'down', status: 503 }),
      { fallback: 'transient_error', transient: true },
    ],
    ['a timeout', new LlmTimeoutError(777), { fallback: 'transient_error', transient: true }],
    [
      'a dropped connection',
      new TypeError('fetch failed'),
      { fallback: 'transient_error', transient: true },
    ],
    [
      'an answer cut at the output cap',
      new LlmTruncatedError({ thoughtsTokens: 0, outputTokens: 4096 }),
      { fallback: 'truncated', transient: false },
    ],
  ];
  it.each(cases)('on failure, classified: %s', async (_name, err, expected) => {
    runLoaded.mockRejectedValue(err);
    expect(await transcribeStagedPdf(FILE, await prepared(), 'layer')).toEqual(expected);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each(['', '   \n '])('an empty transcription (%j) is permanent', async (text) => {
    runLoaded.mockResolvedValue({ text, model: 'm' });
    expect(await transcribeStagedPdf(FILE, await prepared(), 'layer')).toEqual({
      fallback: 'empty_transcription',
      transient: false,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('never writes the transcription, the text layer, a file name or the object path to a log', async () => {
    await transcribeStagedPdf(FILE, await prepared(), SECRET_LAYER);
    runLoaded.mockResolvedValue({ text: '', model: 'm' });
    await transcribeStagedPdf(FILE, await prepared(), SECRET_LAYER);
    runLoaded.mockRejectedValue(new ApiError({ message: 'bad', status: 400 }));
    await transcribeStagedPdf(FILE, await prepared(), SECRET_LAYER);
    const everything = JSON.stringify(Object.values(logs).flatMap((fn) => fn.mock.calls));
    expect(everything).not.toContain(SECRET_TRANSCRIPTION);
    expect(everything).not.toContain(SECRET_LAYER);
    expect(everything).not.toContain('page 1');
    expect(everything).not.toContain('gs://');
    expect(everything).not.toContain('stage-bucket');
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file-1', reason: 'api_error', transient: false }),
      expect.stringContaining('vision_failed'),
    );
  });
});

describe('visionExtractPdf (the raw call the eval makes)', () => {
  it('stages, calls with the given layer and preset, and deletes', async () => {
    const buf = pdfBuf();
    const res = await visionExtractPdf(buf, { preset: PRESET, textLayer: 'L', stage });
    expect(res.text).toContain(SECRET_TRANSCRIPTION);
    expect(stage).toHaveBeenCalledWith(buf);
    expect(runLoaded.mock.calls[0]![0]).toBe(PRESET);
    expect(runLoaded.mock.calls[0]![1].variables).toEqual({ text_layer: 'L' });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('throws the model error, and still deletes', async () => {
    runLoaded.mockRejectedValue(new ApiError({ message: 'bad', status: 400 }));
    await expect(
      visionExtractPdf(pdfBuf(), { preset: PRESET, textLayer: '', stage }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('countPdfPages', () => {
  it('counts pages on a copy: the caller bytes stay intact, and the document is destroyed', async () => {
    const buf = pdfBuf(2);
    const before = Buffer.from(buf);
    expect(await countPdfPages(buf)).toBe(2);
    expect(destroyed.count).toBe(1);
    // pdf.js transferred the copy, not the caller's buffer.
    expect(buf.byteLength).toBe(before.byteLength);
    expect(Buffer.compare(buf, before)).toBe(0);
  });

  it('is null (not a throw) for bytes that are not a PDF', async () => {
    expect(await countPdfPages(Buffer.from('nope'))).toBeNull();
  });
});
