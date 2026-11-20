/**
 * vision-staging.ts — the short-lived Cloud Storage object a vision PDF is
 * read from.
 *
 * Gemini takes a PDF by `gs://` reference, so the bytes never travel inside the
 * request: the job writes the file to DRIVE_VISION_STAGING_BUCKET, the Vertex
 * AI service agent reads it from there, and the job deletes it after the call.
 * The bucket's lifecycle rule is only the backstop for a delete that did not
 * happen (a crash, a failed request).
 *
 * The object name is random: it carries nothing of the file (no name, no Drive
 * id, no path), and it is never logged, so a listing of the bucket or a log
 * line says nothing about whose document it was.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import { PDF_MIME } from './vision-gate';

export interface StagedPdf {
  /** `gs://<bucket>/<random key>`, for a fileData part. */
  uri: string;
  /** Deletes the object. Never throws: a failure is logged and the lifecycle rule is the backstop. */
  remove(): Promise<void>;
}

/** Writes the bytes to the staging bucket. Throws on a failed upload. */
export type PdfStager = (bytes: Buffer) => Promise<StagedPdf>;

/**
 * The client is built on first use (and its module loaded then), so with the
 * flag off the storage library is never touched. ADC auth: the job's service
 * account in deploy, gcloud ADC locally. A bounded retry window keeps a worker
 * from waiting out the library's ten-minute default on a dead network.
 */
let client: import('@google-cloud/storage').Storage | undefined;
async function storage(): Promise<import('@google-cloud/storage').Storage> {
  if (!client) {
    const { Storage } = await import('@google-cloud/storage');
    client = new Storage({ retryOptions: { maxRetries: 3, totalTimeout: 120 } });
  }
  return client;
}

/** The HTTP-style code a storage error carries, if any. */
export function errorCode(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

export const stagePdf: PdfStager = async (bytes) => {
  const bucketName = config.DRIVE_VISION_STAGING_BUCKET;
  if (!bucketName) throw new Error('[drive.vision] DRIVE_VISION_STAGING_BUCKET is not set');
  const objectName = `vision/${randomUUID()}.pdf`;
  const file = (await storage()).bucket(bucketName).file(objectName);
  // Not resumable (its session state is kept in a config file the job may not
  // be able to write); create-only, so the library may retry the upload safely.
  await file.save(bytes, {
    resumable: false,
    contentType: PDF_MIME,
    preconditionOpts: { ifGenerationMatch: 0 },
  });
  let removed = false;
  return {
    uri: `gs://${bucketName}/${objectName}`,
    async remove() {
      if (removed) return;
      removed = true;
      try {
        await file.delete({ ignoreNotFound: true });
      } catch (err) {
        // No object path and no message (storage errors quote the path): the
        // key is random, but nothing in a log should point at a staged document.
        logger.warn(
          { errorName: err instanceof Error ? err.name : 'unknown', code: errorCode(err) },
          '[drive.vision] staged object delete failed — the bucket lifecycle will remove it',
        );
      }
    },
  };
};
