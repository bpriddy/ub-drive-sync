/**
 * extract-vision.ts — Gemini document understanding ("vision") for PDFs.
 *
 * The text layer (unpdf) misses what a PDF only draws: image-set decks, charts,
 * layout. Gemini reads the rendered pages and transcribes them into the marked
 * text the Google-native walkers emit, so interpret consumes it unchanged.
 *
 * The prompt is the database preset `drive.vision_extraction.v1`, edited live
 * like every other drive-sync prompt; nothing of it is in this code. The PDF
 * reaches Gemini by Cloud Storage reference (vision-staging.ts), never inline,
 * and travels with its own text layer: the preset takes exact wording and
 * numbers from the text and describes what is only visible on the pages. For an
 * image-only PDF the text layer is empty.
 *
 * extractText calls this in two steps for a PDF the scan core asked vision for
 * and vision-gate.ts admitted: prepareVisionPdf inside withDownloadedFile (the
 * gates, the preset, the upload: all that needs the bytes), then
 * transcribeStagedPdf after the download slot is released (the long model
 * call holds no download budget). Both leave the text layer as the fallback: a
 * vision failure never fails the scan and never skips a file; it is a
 * downgrade, classified so the worker can tell a permanent one (the text layer
 * is the answer) from a transient one (read the file again later).
 *
 * Never logs the transcription, the text layer, a file name or the staged
 * object's path.
 */
import { config } from '../config';
import { logger } from '../logger';
import { defaultLlm, loadPreset, runLoadedPreset } from '../ai';
import type { LlmUsage, LoadedPreset } from '../ai';
import { thinkingLevelFor } from '../ai/thinking';
import { isRetryableLlmError, LlmTruncatedError } from '../ai/retryable';
import { PDF_MIME } from './vision-gate';
import { errorCode, stagePdf, type PdfStager, type StagedPdf } from './vision-staging';

/** The preset key, and the tag the call's usage is tallied under. */
export const VISION_PRESET_KEY = 'drive.vision_extraction.v1';
export const VISION_TAG = VISION_PRESET_KEY;

export interface VisionExtractionResult {
  text: string;
  model: string;
  usage?: LlmUsage;
}

/** Why a PDF was not transcribed; `transient` ones are worth another read later. */
export interface VisionFallback {
  fallback:
    | 'driver_not_enterprise'
    | 'over_size_cap'
    | 'over_page_cap'
    | 'empty_transcription'
    | 'truncated'
    | 'api_error'
    | 'transient_error'
    | 'preset_unavailable'
    | 'staging_failed';
  transient: boolean;
}

export type VisionAttempt = { text: string } | VisionFallback;

/**
 * Pages of a PDF, counted on a COPY of the bytes: pdf.js transfers (detaches)
 * the buffer it is given, and the caller's bytes are still needed by the
 * staging upload and by the text layer. The copy is bounded by the
 * vision size cap (the caller checked it first), and the document is destroyed
 * before this returns. Null when the parser cannot open the file; that does
 * not rule vision out (a PDF unpdf chokes on is one where vision may still
 * succeed) and the size cap and the output cap still bound the call.
 */
export async function countPdfPages(buf: Buffer): Promise<number | null> {
  try {
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
    try {
      return pdf.numPages;
    } finally {
      await pdf.destroy();
    }
  } catch {
    return null;
  }
}

/**
 * One model call on an already staged PDF: the preset's prompt with the text
 * layer filled in, the file as a Cloud Storage part. Throws on error.
 */
async function callVision(
  preset: LoadedPreset,
  fileUri: string,
  textLayer: string,
): Promise<VisionExtractionResult> {
  const result = await runLoadedPreset(preset, {
    key: VISION_PRESET_KEY,
    variables: { text_layer: textLayer },
    mediaRefs: [{ mimeType: PDF_MIME, fileUri }],
    maxOutputTokens: config.DRIVE_VISION_MAX_OUTPUT_TOKENS,
    // A transcription needs no reasoning, and thoughts count against the
    // output cap. GEMINI_THINKING_BY_TAG can still set the "vision" call type.
    thinkingLevel: thinkingLevelFor(VISION_TAG, config.GEMINI_THINKING_BY_TAG ?? {}) ?? 'MINIMAL',
    timeoutMs: config.GEMINI_TIMEOUT_VISION_MS,
  });
  return {
    text: result.text.trim(),
    model: result.model,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

/**
 * The raw vision call, staging and cleanup included: no gating, throws on
 * error. Exposed so the eval can measure latency and tokens without the
 * fallback swallowing failures. `textLayer` is '' for pages alone.
 */
export async function visionExtractPdf(
  buf: Buffer,
  opts: { preset: LoadedPreset; textLayer: string; stage?: PdfStager },
): Promise<VisionExtractionResult> {
  const staged = await (opts.stage ?? stagePdf)(buf);
  try {
    return await callVision(opts.preset, staged.uri, opts.textLayer);
  } finally {
    await staged.remove();
  }
}

function classify(err: unknown): VisionFallback {
  if (err instanceof LlmTruncatedError) return { fallback: 'truncated', transient: false };
  if (isRetryableLlmError(err)) return { fallback: 'transient_error', transient: true };
  return { fallback: 'api_error', transient: false };
}

/** A PDF that passed the gates and now sits in the staging bucket, with its preset. */
export interface PreparedVision {
  preset: LoadedPreset;
  staged: StagedPdf;
  sizeBytes: number;
  pageCount: number | null;
}

export type VisionPrep = { prepared: PreparedVision } | VisionFallback;

/**
 * Step one, with the bytes in hand: the runtime gates, the preset, and the
 * upload. `{ prepared }` must be handed to transcribeStagedPdf, which deletes
 * the staged object; anything else says why the text layer must answer
 * instead, and left nothing in the bucket. The metadata gate (flag, size cap)
 * already ran in vision-gate.ts; the size is re-checked here against the bytes
 * actually received. The preset is read before the upload, so a missing or
 * inactive one costs no transfer.
 */
export async function prepareVisionPdf(
  file: { id: string },
  buf: Buffer,
  stage: PdfStager = stagePdf,
): Promise<VisionPrep> {
  // Pages and documents can carry personal data: only the enterprise surface
  // (ADC, project terms) takes vision traffic. The mock returns a schema stub,
  // not a transcription, and storing that would poison the pipeline.
  if (defaultLlm.name !== 'gemini-enterprise') {
    logger.debug(
      { fileId: file.id, driver: defaultLlm.name },
      '[drive.vision] driver not enterprise',
    );
    return { fallback: 'driver_not_enterprise', transient: false };
  }
  const sizeBytes = buf.byteLength;
  if (sizeBytes > config.DRIVE_VISION_MAX_FILE_SIZE_BYTES) {
    logger.debug({ fileId: file.id, sizeBytes }, '[drive.vision] over size cap');
    return { fallback: 'over_size_cap', transient: false };
  }
  const pageCount = await countPdfPages(buf);
  if (pageCount !== null && pageCount > config.DRIVE_VISION_MAX_PDF_PAGES) {
    logger.debug({ fileId: file.id, pageCount }, '[drive.vision] over page cap');
    return { fallback: 'over_page_cap', transient: false };
  }
  let preset: LoadedPreset;
  try {
    preset = await loadPreset(VISION_PRESET_KEY);
  } catch (err) {
    // Missing, inactive or the database unreachable: a configuration state
    // that gets fixed, so the file is read again at its next event.
    logger.warn(
      {
        fileId: file.id,
        presetKey: VISION_PRESET_KEY,
        reason: 'preset_unavailable',
        errorName: err instanceof Error ? err.name : 'unknown',
      },
      '[drive.vision] vision_failed — preset unavailable, using the text layer',
    );
    return { fallback: 'preset_unavailable', transient: true };
  }
  try {
    const staged = await stage(buf);
    return { prepared: { preset, staged, sizeBytes, pageCount } };
  } catch (err) {
    // The error may quote the object path; only its class and code are kept.
    logger.warn(
      {
        fileId: file.id,
        sizeBytes,
        reason: 'staging_failed',
        errorName: err instanceof Error ? err.name : 'unknown',
        code: errorCode(err),
      },
      '[drive.vision] vision_failed — staging upload failed, using the text layer',
    );
    return { fallback: 'staging_failed', transient: true };
  }
}

/**
 * Step two: the model call on the staged PDF, with the PDF's text layer ('' for
 * an image-only one). The staged object is deleted afterwards, on success and
 * on failure alike. `{ text }` is a non-empty transcription; anything else says
 * why the text layer must answer instead.
 */
export async function transcribeStagedPdf(
  file: { id: string },
  prepared: PreparedVision,
  textLayer: string,
): Promise<VisionAttempt> {
  const { sizeBytes, pageCount } = prepared;
  try {
    const { text } = await callVision(prepared.preset, prepared.staged.uri, textLayer);
    if (!text) {
      logger.warn(
        { fileId: file.id, sizeBytes, pageCount },
        '[drive.vision] vision_failed: empty transcription — using the text layer',
      );
      return { fallback: 'empty_transcription', transient: false };
    }
    return { text };
  } catch (err) {
    const failure = classify(err);
    // The driver already retried what it could; `err` carries a status and the
    // server's message, never the file's text.
    logger.warn(
      {
        err,
        fileId: file.id,
        sizeBytes,
        pageCount,
        reason: failure.fallback,
        transient: failure.transient,
      },
      '[drive.vision] vision_failed — using the text layer',
    );
    return failure;
  } finally {
    await prepared.staged.remove();
  }
}
