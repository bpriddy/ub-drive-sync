/** runPreset threads the thinking level from GEMINI_THINKING_BY_TAG by preset key. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  complete: vi.fn(),
  captureCall: vi.fn(),
  config: {
    GEMINI_THINKING_BY_TAG: {} as Record<string, string>,
    GEMINI_CAPTURE_DIR: undefined as string | undefined,
  },
}));

vi.mock('../../config', () => ({ config: m.config }));
vi.mock('../../prisma', () => ({ prisma: { promptPreset: { findUnique: m.findUnique } } }));
vi.mock('../gemini.client', () => ({ defaultLlm: { complete: m.complete } }));
vi.mock('../capture', () => ({ captureCall: m.captureCall }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { loadPreset, runLoadedPreset, runPreset } from '../prompt-preset.service';

const run = (extra: { thinkingLevel?: 'LOW' | 'HIGH' } = {}) =>
  runPreset({ key: 'drive.file_extraction.v1', variables: { name: 'x' }, ...extra });

beforeEach(() => {
  m.config.GEMINI_THINKING_BY_TAG = {};
  m.config.GEMINI_CAPTURE_DIR = undefined;
  m.captureCall.mockReset();
  m.findUnique.mockResolvedValue({
    key: 'drive.file_extraction.v1',
    isActive: true,
    template: 'Hello {{name}}',
    model: 'gemini-test',
    temperature: '0.2',
  });
  m.complete.mockReset().mockResolvedValue({ text: '{}', driver: 'gemini', model: 'gemini-test' });
});

describe('runPreset thinking level', () => {
  it('sends no thinking level while the map is empty (today, and the rollback)', async () => {
    await run();
    expect(m.complete).toHaveBeenCalledTimes(1);
    expect(m.complete.mock.calls[0]![0]).not.toHaveProperty('thinkingLevel');
  });

  it("sends the mapped level for the preset's call type", async () => {
    m.config.GEMINI_THINKING_BY_TAG = { interpret: 'LOW' };
    await run();
    expect(m.complete).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'drive.file_extraction.v1', thinkingLevel: 'LOW' }),
    );
  });

  it("lets the caller's own level win over the map", async () => {
    m.config.GEMINI_THINKING_BY_TAG = { interpret: 'LOW' };
    await run({ thinkingLevel: 'HIGH' });
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: 'HIGH' }));
  });
});

describe('runPreset capture', () => {
  it('captures nothing unless GEMINI_CAPTURE_DIR is set', async () => {
    await run();
    expect(m.captureCall).not.toHaveBeenCalled();
  });

  it('records the rendered prompt and the answer when it is set', async () => {
    m.config.GEMINI_CAPTURE_DIR = '/outside/capture';
    m.config.GEMINI_THINKING_BY_TAG = { interpret: 'LOW' };
    await run();
    expect(m.captureCall).toHaveBeenCalledWith(
      '/outside/capture',
      expect.objectContaining({
        key: 'drive.file_extraction.v1',
        model: 'gemini-test',
        temperature: 0.2,
        prompt: 'Hello x',
        thinkingLevel: 'LOW',
        result: { text: '{}', finishReason: null, usage: null },
      }),
    );
  });
});

describe('runPreset request shape (existing callers are unchanged)', () => {
  it('sends exactly the keys it always did: no media, no output cap', async () => {
    await run();
    expect(Object.keys(m.complete.mock.calls[0]![0]).sort()).toEqual([
      'model',
      'prompt',
      'tag',
      'temperature',
    ]);
    expect(m.complete.mock.calls[0]![0]).toMatchObject({
      model: 'gemini-test',
      temperature: 0.2,
      prompt: 'Hello x',
      tag: 'drive.file_extraction.v1',
    });
  });

  it('still throws for a missing or inactive preset, with the same messages', async () => {
    m.findUnique.mockResolvedValueOnce(null);
    await expect(run()).rejects.toThrow(
      '[prompt-preset] no preset found with key=drive.file_extraction.v1',
    );
    m.findUnique.mockResolvedValueOnce({ key: 'k', isActive: false });
    await expect(run()).rejects.toThrow(
      '[prompt-preset] preset drive.file_extraction.v1 is inactive',
    );
    expect(m.complete).not.toHaveBeenCalled();
  });
});

describe('loadPreset and runLoadedPreset (the vision preset: media by reference)', () => {
  it('loads the row once and returns the fields a call needs', async () => {
    m.findUnique.mockClear();
    await expect(loadPreset('drive.file_extraction.v1')).resolves.toEqual({
      key: 'drive.file_extraction.v1',
      template: 'Hello {{name}}',
      model: 'gemini-test',
      temperature: 0.2,
    });
    expect(m.findUnique).toHaveBeenCalledTimes(1);
  });

  it('renders the variables (an empty one as nothing) and sends the file part, output cap and level', async () => {
    m.findUnique.mockClear();
    const preset = {
      key: 'drive.vision_extraction.v1',
      template: 'Layer:\n{{text_layer}}\nend',
      model: 'gemini-test',
      temperature: 0,
    };
    await runLoadedPreset(preset, {
      key: preset.key,
      variables: { text_layer: '' },
      mediaRefs: [{ mimeType: 'application/pdf', fileUri: 'gs://b/vision/k.pdf' }],
      maxOutputTokens: 123,
      thinkingLevel: 'MINIMAL',
      timeoutMs: 5,
    });
    expect(m.findUnique).not.toHaveBeenCalled();
    expect(m.complete).toHaveBeenCalledWith({
      model: 'gemini-test',
      temperature: 0,
      prompt: 'Layer:\n\nend',
      tag: 'drive.vision_extraction.v1',
      timeoutMs: 5,
      thinkingLevel: 'MINIMAL',
      maxOutputTokens: 123,
      mediaRefs: [{ mimeType: 'application/pdf', fileUri: 'gs://b/vision/k.pdf' }],
    });
    await runLoadedPreset(preset, {
      key: preset.key,
      variables: { text_layer: 'exact {{name}} 42' },
    });
    // A value is inserted as it is, never re-read as a placeholder.
    expect(m.complete.mock.calls[1]![0].prompt).toBe('Layer:\nexact {{name}} 42\nend');
    expect(m.complete.mock.calls[1]![0]).not.toHaveProperty('mediaRefs');
  });
});
