/**
 * createRealLlm must never hand a paid run the mock driver. The client module is replaced by a
 * stub here: no real client is built, nothing is called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../../ai/gemini.client');
});

describe('createRealLlm', () => {
  it('throws when the client module selected the mock driver', async () => {
    vi.doMock('../../../ai/gemini.client', () => ({ defaultLlm: { name: 'mock' } }));
    const { createRealLlm } = await import('../real-llm');
    await expect(createRealLlm()).rejects.toThrow(/mock driver/);
  });

  it('returns a real driver unchanged', async () => {
    const driver = { name: 'gemini' };
    vi.doMock('../../../ai/gemini.client', () => ({ defaultLlm: driver }));
    const { createRealLlm } = await import('../real-llm');
    await expect(createRealLlm()).resolves.toBe(driver);
  });
});
