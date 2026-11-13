/**
 * Env validation for the memory-bound settings: the download budget
 * (DOWNLOAD_INFLIGHT_BYTES / DOWNLOAD_HEAVY_BYTES) and the native character cap
 * (NATIVE_MAX_CHARS). `config.ts` runs loadConfig() at import, so the one
 * required variable is set before the module loads; each test then calls
 * loadConfig() itself against a controlled environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/test';
});

import { loadConfig } from '../config';

const MIB = 1024 * 1024;
const KEYS = [
  'DOWNLOAD_INFLIGHT_BYTES',
  'DOWNLOAD_HEAVY_BYTES',
  'NATIVE_MAX_CHARS',
  'DRIVE_VISION_PDF',
  'DRIVE_VISION_MAX_FILE_SIZE_BYTES',
  'DRIVE_VISION_MAX_PDF_PAGES',
  'DRIVE_VISION_MAX_OUTPUT_TOKENS',
  'GEMINI_TIMEOUT_VISION_MS',
  'GEMINI_THINKING_BY_TAG',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('download budget settings', () => {
  it('default to a 600 MiB in-flight budget and a 50 MiB heavy threshold', () => {
    const c = loadConfig();
    expect(c.DOWNLOAD_INFLIGHT_BYTES).toBe(600 * MIB);
    expect(c.DOWNLOAD_HEAVY_BYTES).toBe(50 * MIB);
  });

  it('parse overrides as integers, and treat an empty string as unset', () => {
    process.env['DOWNLOAD_INFLIGHT_BYTES'] = '';
    process.env['DOWNLOAD_HEAVY_BYTES'] = '1000';
    const c = loadConfig();
    expect(c.DOWNLOAD_INFLIGHT_BYTES).toBe(600 * MIB);
    expect(c.DOWNLOAD_HEAVY_BYTES).toBe(1000);
  });

  it('accept a heavy threshold equal to the budget', () => {
    process.env['DOWNLOAD_INFLIGHT_BYTES'] = '1000';
    process.env['DOWNLOAD_HEAVY_BYTES'] = '1000';
    expect(() => loadConfig()).not.toThrow();
  });

  it('fail boot when the heavy threshold exceeds the budget', () => {
    process.env['DOWNLOAD_INFLIGHT_BYTES'] = '1000';
    process.env['DOWNLOAD_HEAVY_BYTES'] = '1001';
    expect(() => loadConfig()).toThrow(
      /DOWNLOAD_HEAVY_BYTES: must not exceed DOWNLOAD_INFLIGHT_BYTES \(1001 > 1000\)/,
    );
  });

  it('fail boot when a heavy threshold above the default budget is set alone', () => {
    process.env['DOWNLOAD_HEAVY_BYTES'] = String(700 * MIB);
    expect(() => loadConfig()).toThrow(/DOWNLOAD_HEAVY_BYTES: must not exceed/);
  });

  // 1e300 parses as an "integer" but no byte count is that large: refused at
  // boot, not at the first download when the budget is built.
  it.each(['0', '-5', '1.5', 'abc', '1e', '1e300'])('reject %j as a size', (bad) => {
    process.env['DOWNLOAD_INFLIGHT_BYTES'] = bad;
    expect(() => loadConfig()).toThrow(/DOWNLOAD_INFLIGHT_BYTES/);
    delete process.env['DOWNLOAD_INFLIGHT_BYTES'];
    process.env['DOWNLOAD_HEAVY_BYTES'] = bad;
    expect(() => loadConfig()).toThrow(/DOWNLOAD_HEAVY_BYTES/);
  });
});

describe('NATIVE_MAX_CHARS', () => {
  it('defaults to 2,000,000 characters', () => {
    expect(loadConfig().NATIVE_MAX_CHARS).toBe(2_000_000);
  });

  it('parses an override, and treats an empty string as unset', () => {
    process.env['NATIVE_MAX_CHARS'] = '500000';
    expect(loadConfig().NATIVE_MAX_CHARS).toBe(500_000);
    process.env['NATIVE_MAX_CHARS'] = '';
    expect(loadConfig().NATIVE_MAX_CHARS).toBe(2_000_000);
  });

  it.each(['0', '-1', '1.5', 'abc', '1e300'])('rejects %j', (bad) => {
    process.env['NATIVE_MAX_CHARS'] = bad;
    expect(() => loadConfig()).toThrow(/NATIVE_MAX_CHARS/);
  });
});

describe('vision extraction settings', () => {
  it('default to off, with the caps and the deadline chosen for it', () => {
    const c = loadConfig();
    expect(c.DRIVE_VISION_PDF).toBe('off');
    expect(c.DRIVE_VISION_MAX_FILE_SIZE_BYTES).toBe(14 * MIB);
    expect(c.DRIVE_VISION_MAX_PDF_PAGES).toBe(50);
    expect(c.DRIVE_VISION_MAX_OUTPUT_TOKENS).toBe(32768);
    expect(c.GEMINI_TIMEOUT_VISION_MS).toBe(180000);
  });

  it('turn on only by the exact word, and reject anything else at boot', () => {
    process.env['DRIVE_VISION_PDF'] = 'on';
    expect(loadConfig().DRIVE_VISION_PDF).toBe('on');
    for (const bad of ['true', 'ON', '1']) {
      process.env['DRIVE_VISION_PDF'] = bad;
      expect(() => loadConfig()).toThrow(/DRIVE_VISION_PDF/);
    }
  });

  it.each(['0', '-1', '1.5', 'abc'])('reject %j as a page cap', (bad) => {
    process.env['DRIVE_VISION_MAX_PDF_PAGES'] = bad;
    expect(() => loadConfig()).toThrow(/DRIVE_VISION_MAX_PDF_PAGES/);
  });

  it('let GEMINI_THINKING_BY_TAG address the vision call type', () => {
    process.env['GEMINI_THINKING_BY_TAG'] = '{"vision":"LOW"}';
    expect(loadConfig().GEMINI_THINKING_BY_TAG).toEqual({ vision: 'LOW' });
  });
});
