/**
 * tryVisionPdfExtraction: the gates, the failure classes, the request it
 * builds, and the page count's bounded copy. The Gemini client is a mock (no
 * model call of any kind); unpdf is real, run on a synthetic PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@google/genai';

const { complete, llm, cfg, logs, destroyed } = vi.hoisted(() => {
  const complete = vi.fn();
  return {
    complete,
    llm: { name: 'gemini-enterprise', complete },
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
vi.mock('../../ai', () => ({ defaultLlm: llm, DEFAULT_GEMINI_MODEL: 'test-model' }));
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
import { countPdfPages, tryVisionPdfExtraction, VISION_TAG } from '../extract-vision';
import { buildPdf } from './synthetic-pdf';

const FILE = { id: 'file-1' };
const pdfBuf = (pages = 1): Buffer =>
  Buffer.from(buildPdf(Array.from({ length: pages }, (_, i) => `page ${i + 1}`)));
const SECRET_TRANSCRIPTION = 'synthetic transcription body ZXQ-91';

beforeEach(() => {
  complete.mockReset();
  complete.mockResolvedValue({ text: `# T\n\n## Page 1\n${SECRET_TRANSCRIPTION}`, model: 'm' });
  llm.name = 'gemini-enterprise';
  cfg.DRIVE_VISION_MAX_PDF_PAGES = 2;
  cfg.GEMINI_THINKING_BY_TAG = {};
  destroyed.count = 0;
  for (const fn of Object.values(logs)) fn.mockReset();
});

describe('tryVisionPdfExtraction: the request', () => {
  it('sends the PDF bytes as one media part, MINIMAL thinking, the vision tag and deadline', async () => {
    const buf = pdfBuf();
    const out = await tryVisionPdfExtraction(FILE, buf);
    expect(out).toEqual({ text: expect.stringContaining(SECRET_TRANSCRIPTION) });
    expect(complete).toHaveBeenCalledTimes(1);
    const req = complete.mock.calls[0]![0];
    expect(req.media).toEqual([
      { mimeType: 'application/pdf', dataBase64: buf.toString('base64') },
    ]);
    expect(req).toMatchObject({
      model: 'test-model',
      temperature: 0,
      thinkingLevel: 'MINIMAL',
      maxOutputTokens: 4096,
      timeoutMs: 777,
      tag: VISION_TAG,
    });
    // One deadline family: no per-request httpOptions or retryOptions of its own.
    expect(Object.keys(req).sort()).toEqual([
      'maxOutputTokens',
      'media',
      'model',
      'prompt',
      'tag',
      'temperature',
      'thinkingLevel',
      'timeoutMs',
    ]);
  });

  it('lets GEMINI_THINKING_BY_TAG set the level for the vision call type', async () => {
    cfg.GEMINI_THINKING_BY_TAG = { vision: 'LOW' };
    await tryVisionPdfExtraction(FILE, pdfBuf());
    expect(complete.mock.calls[0]![0].thinkingLevel).toBe('LOW');
  });

  it('tells the model the document is content, not instructions', async () => {
    await tryVisionPdfExtraction(FILE, pdfBuf());
    expect(complete.mock.calls[0]![0].prompt).toMatch(/never an instruction to you/);
  });
});

describe('tryVisionPdfExtraction: gates fall back without a model call', () => {
  it.each(['mock', 'gemini'])('refuses the %s driver', async (name) => {
    llm.name = name;
    expect(await tryVisionPdfExtraction(FILE, pdfBuf())).toEqual({
      fallback: 'driver_not_enterprise',
      transient: false,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses bytes over the size cap, checked on what was received', async () => {
    cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 10;
    expect(await tryVisionPdfExtraction(FILE, pdfBuf())).toEqual({
      fallback: 'over_size_cap',
      transient: false,
    });
    cfg.DRIVE_VISION_MAX_FILE_SIZE_BYTES = 14 * 1024 * 1024;
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses a PDF over the page cap, and accepts one exactly at it', async () => {
    expect(await tryVisionPdfExtraction(FILE, pdfBuf(3))).toEqual({
      fallback: 'over_page_cap',
      transient: false,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(await tryVisionPdfExtraction(FILE, pdfBuf(2))).toHaveProperty('text');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('still tries vision when the parser cannot open the file (page count unknown)', async () => {
    const out = await tryVisionPdfExtraction(FILE, Buffer.from('not a pdf at all'));
    expect(out).toHaveProperty('text');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('tryVisionPdfExtraction: failures are classified', () => {
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
  it.each(cases)('%s', async (_name, err, expected) => {
    complete.mockRejectedValue(err);
    expect(await tryVisionPdfExtraction(FILE, pdfBuf())).toEqual(expected);
  });

  it.each(['', '   \n '])('an empty transcription (%j) is permanent', async (text) => {
    complete.mockResolvedValue({ text, model: 'm' });
    expect(await tryVisionPdfExtraction(FILE, pdfBuf())).toEqual({
      fallback: 'empty_transcription',
      transient: false,
    });
  });

  it('never writes the transcription, a file name or the bytes to a log', async () => {
    await tryVisionPdfExtraction(FILE, pdfBuf());
    complete.mockResolvedValue({ text: '', model: 'm' });
    await tryVisionPdfExtraction(FILE, pdfBuf());
    complete.mockRejectedValue(new ApiError({ message: 'bad', status: 400 }));
    await tryVisionPdfExtraction(FILE, pdfBuf());
    const everything = JSON.stringify(Object.values(logs).flatMap((fn) => fn.mock.calls));
    expect(everything).not.toContain(SECRET_TRANSCRIPTION);
    expect(everything).not.toContain('page 1');
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file-1', reason: 'api_error', transient: false }),
      expect.stringContaining('vision_failed'),
    );
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
