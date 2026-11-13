/**
 * vision-gate.ts — which PDFs go to vision, decided from metadata alone.
 *
 * Config-only on purpose (no model client, no I/O): extract.ts asks it before
 * a download, content-gate.ts before hashing, and neither may pull the Gemini
 * client in when vision is off.
 */
import { config } from '../config';

export const PDF_MIME = 'application/pdf';

/**
 * The download reservation for a PDF that will go to vision, as a multiple of
 * its size. A vision call holds the file, its base64 (about 1.33x) and the
 * serialized request body (about 1.33x again) at once, and the page count's
 * copy is released before either is built: about 3.7x, rounded up.
 */
export const VISION_RESERVE_FACTOR = 4;

/**
 * True when the scan core would send this file to vision: the flag is on, it
 * is a PDF, and Drive's metadata size is known and within
 * DRIVE_VISION_MAX_FILE_SIZE_BYTES. An unknown size (a shortcut's target)
 * keeps the text layer: the cap cannot be checked before the download.
 */
export function isVisionPdf(file: { mimeType: string; size: number | null }): boolean {
  return (
    config.DRIVE_VISION_PDF === 'on' &&
    file.mimeType === PDF_MIME &&
    file.size != null &&
    file.size > 0 &&
    file.size <= config.DRIVE_VISION_MAX_FILE_SIZE_BYTES
  );
}

/**
 * Appended to the unchanged-content hash input of a vision PDF, and only then,
 * so every other hash (flag off, other types) stays byte-identical. Bump it to
 * re-read the vision PDFs once after a change to the transcription prompt.
 */
export const VISION_HASH_MARKER = 'vision-pdf-v1';
