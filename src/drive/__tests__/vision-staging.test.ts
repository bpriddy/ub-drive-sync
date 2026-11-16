/**
 * stagePdf: the object the vision PDF is read from. The storage client is a
 * mock (no Cloud Storage call): what is checked is what the job asks of it, the
 * object's name, and that nothing a log or a listing could show points at a
 * document.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { save, del, fileFn, bucketFn, ctor, cfg, logs } = vi.hoisted(() => {
  const save = vi.fn();
  const del = vi.fn();
  const fileFn = vi.fn((_name: string) => ({ save, delete: del }));
  const bucketFn = vi.fn((_name: string) => ({ file: fileFn }));
  const ctor = vi.fn();
  return {
    save,
    del,
    fileFn,
    bucketFn,
    ctor,
    cfg: { DRIVE_VISION_STAGING_BUCKET: 'stage-bucket' as string | undefined },
    logs: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('../../config', () => ({ config: cfg }));
vi.mock('../../logger', () => ({ logger: logs }));
vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    constructor(opts: unknown) {
      ctor(opts);
    }
    bucket = bucketFn;
  },
}));

import { stagePdf } from '../vision-staging';

const BYTES = Buffer.from('%PDF-synthetic');

beforeEach(() => {
  cfg.DRIVE_VISION_STAGING_BUCKET = 'stage-bucket';
  save.mockReset().mockResolvedValue(undefined);
  del.mockReset().mockResolvedValue(undefined);
  fileFn.mockClear();
  bucketFn.mockClear();
  for (const fn of Object.values(logs)) fn.mockReset();
});

describe('stagePdf', () => {
  it('writes the bytes to the configured bucket as a create-only, non-resumable PDF object', async () => {
    const staged = await stagePdf(BYTES);
    expect(bucketFn).toHaveBeenCalledWith('stage-bucket');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(BYTES, {
      resumable: false,
      contentType: 'application/pdf',
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    expect(staged.uri).toBe(`gs://stage-bucket/${fileFn.mock.calls[0]![0]}`);
  });

  it('names the object by a random key: nothing of the file, and a new key every time', async () => {
    const a = await stagePdf(BYTES);
    const b = await stagePdf(BYTES);
    const key =
      /^gs:\/\/stage-bucket\/vision\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/;
    expect(a.uri).toMatch(key);
    expect(b.uri).toMatch(key);
    expect(a.uri).not.toBe(b.uri);
  });

  it('deletes the object on remove(), tolerating one already gone, and only once', async () => {
    const staged = await stagePdf(BYTES);
    await staged.remove();
    await staged.remove();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('never throws from remove(); a failed delete is a warning without the object path or the error text', async () => {
    del.mockRejectedValue(
      Object.assign(new Error('forbidden: stage-bucket/vision/secret-key.pdf'), { code: 403 }),
    );
    const staged = await stagePdf(BYTES);
    await expect(staged.remove()).resolves.toBeUndefined();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    const everything = JSON.stringify(logs.warn.mock.calls);
    expect(everything).toContain('403');
    expect(everything).not.toContain('stage-bucket');
    expect(everything).not.toContain('secret-key');
    expect(everything).not.toContain(staged.uri);
  });

  it('propagates a failed upload (the caller falls back), leaving nothing to delete', async () => {
    save.mockRejectedValue(new Error('upload failed'));
    await expect(stagePdf(BYTES)).rejects.toThrow('upload failed');
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses to run without a bucket', async () => {
    cfg.DRIVE_VISION_STAGING_BUCKET = undefined;
    await expect(stagePdf(BYTES)).rejects.toThrow(/DRIVE_VISION_STAGING_BUCKET/);
    expect(save).not.toHaveBeenCalled();
  });
});
