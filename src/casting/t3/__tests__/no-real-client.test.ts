/**
 * Guard: the stage core can never construct the real model client.
 *
 * Three layers, so a regression has to get past all of them:
 *  1. static: no file of the stage except real-llm.ts mentions the client
 *     module, the `ai` index (which builds the driver at import) or config;
 *     only real-llm.ts and real-reader.ts reach the extractor, and only lazily.
 *  2. dynamic: with the client module mocked to throw on evaluation, importing
 *     the whole public surface and running dry-run and the apply guards works.
 *  3. the factory is the only way in: it is not called in dry-run, nor when an
 *     apply guard refuses (covered in run.test.ts), and createRealLlm does not
 *     import the client until it is called.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const dir = path.resolve(__dirname, '..');
const sources = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));

const codeOf = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

describe('static: who may reach the client, config or the extractor', () => {
  it('only real-llm.ts mentions gemini.client', () => {
    const hits = sources.filter((s) => codeOf(s.text).includes('gemini.client')).map((s) => s.file);
    expect(hits).toEqual(['real-llm.ts']);
  });

  it('nobody imports the ai index, config, prisma or the logger (they build clients at import)', () => {
    const forbidden = /from '(\.\.\/)+(ai|ai\/index|config|prisma|logger)'/;
    const hits = sources.filter((s) => forbidden.test(codeOf(s.text))).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('the extractor is imported only by real-reader.ts, and only through a dynamic import', () => {
    const hits = sources.filter((s) => codeOf(s.text).includes('drive/extract')).map((s) => s.file);
    expect(hits).toEqual(['real-reader.ts']);
    const reader = codeOf(sources.find((s) => s.file === 'real-reader.ts')?.text ?? '');
    expect(reader).not.toMatch(/^import .*drive\/extract/m);
    expect(reader).toMatch(/await import\('\.\.\/\.\.\/drive\/extract'\)/);
  });

  it('only real-llm.ts and real-reader.ts have a dynamic import at all', () => {
    const hits = sources
      .filter((s) => /\bimport\(/.test(codeOf(s.text)))
      .map((s) => s.file)
      .sort();
    expect(hits).toEqual(['real-llm.ts', 'real-reader.ts']);
  });

  it('the public index does not re-export the real wiring', () => {
    const index = codeOf(sources.find((s) => s.file === 'index.ts')?.text ?? '');
    expect(index).not.toMatch(/real-llm|real-reader/);
  });

  it('every non-test source file imports only relative modules or an allowlist of packages', () => {
    const allowed = new Set(['@google/genai', 'zod', 'node:crypto', 'node:fs', 'node:path']);
    for (const s of sources) {
      for (const m of codeOf(s.text).matchAll(/from '([^']+)'/g)) {
        const spec = m[1] as string;
        if (spec.startsWith('.')) continue;
        expect(allowed.has(spec), `${s.file} imports ${spec}`).toBe(true);
      }
    }
  });
});

describe('dynamic: the client module is poisoned', () => {
  it('importing the surface and running dry-run never evaluates it', async () => {
    vi.resetModules();
    const evaluated = vi.fn();
    vi.doMock('../../../ai/gemini.client', () => {
      evaluated();
      throw new Error('the real client must never be constructed here');
    });
    vi.doMock('../../../config', () => {
      evaluated();
      throw new Error('config must never be loaded here');
    });
    const t3 = await import('../index');
    const { MemoryLedger, MemorySink } = t3;
    const { buildRosterIndex } = await import('../../identity');
    const factory = vi.fn();
    const report = await t3.runT3(
      { policy: { windowStart: '2021-11-19' }, model: 'gemini-3.5-flash', thinkingLevel: 'LOW' },
      {
        reader: { read: async () => ({ kind: 'skip', reason: 'empty' }) },
        ledger: new MemoryLedger(),
        sink: new MemorySink(),
        roster: buildRosterIndex([]),
        llmFactory: factory,
      },
      [],
    );
    expect(report.mode).toBe('dry-run');
    await expect(
      t3.runT3(
        {
          mode: 'apply',
          policy: { windowStart: '2021-11-19' },
          model: 'gemini-3.5-flash',
          thinkingLevel: 'LOW',
        },
        {
          reader: { read: async () => ({ kind: 'skip', reason: 'empty' }) },
          ledger: new MemoryLedger(),
          sink: new MemorySink(),
          roster: buildRosterIndex([]),
          llmFactory: factory,
        },
        [],
      ),
    ).rejects.toThrow(/approval/);
    expect(factory).not.toHaveBeenCalled();
    expect(evaluated).not.toHaveBeenCalled();
    vi.doUnmock('../../../ai/gemini.client');
    vi.doUnmock('../../../config');
  });

  it('createRealLlm imports the client only when called (here: when it is poisoned, it fails there)', async () => {
    vi.resetModules();
    const evaluated = vi.fn();
    vi.doMock('../../../ai/gemini.client', () => {
      evaluated();
      throw new Error('poisoned');
    });
    const mod = await import('../real-llm');
    expect(evaluated).not.toHaveBeenCalled();
    // vitest wraps an error thrown by a mock factory, so match either message.
    await expect(mod.createRealLlm()).rejects.toThrow(/poisoned|error when mocking/);
    expect(evaluated).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../../ai/gemini.client');
  });
});
