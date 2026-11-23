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
 *
 * The pilot driver (pilot-main.ts, with real-pilot-io.ts behind it) is a DELIBERATE
 * extension of the allow-list: it is the one entry point that may reach the model client
 * (real-llm.ts), the extractor (real-reader.ts) and the live listing (real-pilot-io.ts),
 * each only through a dynamic import inside a lazy factory. The pilot core (pilot.ts,
 * pilot-args.ts, sample.ts, listing-candidates.ts) stays hermetic and is held to the
 * unchanged rules below.
 *
 * The ledger loader (load-main.ts, with pg-sink.ts and real-pilot-io.ts behind it) is a second
 * DELIBERATE extension, and a narrower one: it reads the staff roster and writes Layer 1 rows,
 * so it may load Prisma (`pg-sink.ts` imports `@prisma/client`; `load-main.ts` imports the
 * `prisma` singleton lazily) and `real-pilot-io.ts` (roster only), but it must never reach the
 * model client, the genai SDK, `real-llm.ts`, `real-reader.ts` or Drive. The loader core
 * (load.ts, load-args.ts) stays hermetic. See the "ledger loader" blocks below.
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

  it('only the real wiring files and the pilot entry point have a dynamic import at all', () => {
    const hits = sources
      .filter((s) => /\bimport\(/.test(codeOf(s.text)))
      .map((s) => s.file)
      .sort();
    // pilot-main.ts and real-pilot-io.ts: the deliberate allow-list extension for pilot P1;
    // load-main.ts: the ledger loader's (roster and Prisma sink only, never a model).
    expect(hits).toEqual([
      'load-main.ts',
      'pilot-main.ts',
      'real-llm.ts',
      'real-pilot-io.ts',
      'real-reader.ts',
    ]);
  });

  it('nobody imports the real wiring statically, and only the pilot entry point names it', () => {
    const named = sources
      .filter((s) => /real-(llm|reader|pilot-io)/.test(codeOf(s.text)))
      .map((s) => s.file)
      .sort();
    // run.ts and the index only mention them in comments, which codeOf strips.
    // load-main.ts names real-pilot-io only (the roster); the loader-specific block below
    // holds it to never naming real-llm or real-reader.
    expect(named).toEqual(['load-main.ts', 'pilot-main.ts']);
    for (const s of sources) {
      expect(codeOf(s.text), s.file).not.toMatch(/^import[^;]*from '\.\/real-/m);
    }
    const main = codeOf(sources.find((s) => s.file === 'pilot-main.ts')?.text ?? '');
    expect(main).toMatch(/await import\('\.\/real-llm'\)/);
    expect(main).toMatch(/await import\('\.\/real-reader'\)/);
    expect(main).toMatch(/\(await import\('\.\/real-pilot-io'\)\)/);
  });

  it('the pilot core imports no config, Prisma, Drive or model code, not even lazily', () => {
    for (const f of ['pilot.ts', 'pilot-args.ts', 'sample.ts', 'listing-candidates.ts']) {
      const code = codeOf(sources.find((s) => s.file === f)?.text ?? '');
      expect(code, f).not.toMatch(/\bimport\(/);
      expect(code, f).not.toMatch(/real-|gemini|prisma|\.\.\/\.\.\/config|\.\.\/\.\.\/logger/);
    }
    // listing-candidates.ts reads only two pure Drive modules (a regexp and a type).
    const lc = codeOf(sources.find((s) => s.file === 'listing-candidates.ts')?.text ?? '');
    expect([...lc.matchAll(/from '(\.\.\/\.\.\/[^']+)'/g)].map((m) => m[1]).sort()).toEqual([
      '../../drive/job-number',
      '../../drive/types',
    ]);
  });

  it('the public index does not re-export the real wiring', () => {
    const index = codeOf(sources.find((s) => s.file === 'index.ts')?.text ?? '');
    expect(index).not.toMatch(/real-llm|real-reader/);
  });

  it('every non-test source file imports only relative modules or an allowlist of packages', () => {
    const allowed = new Set(['@google/genai', 'zod', 'node:crypto', 'node:fs', 'node:path']);
    // The one deliberate addition for the ledger loader: the Postgres sink talks to Prisma.
    // row.ts takes the closed sets and the quote limit from the schemas package (pure constants).
    const perFile: Record<string, readonly string[]> = {
      'pg-sink.ts': ['@prisma/client'],
      'row.ts': ['@anomaly-technology/gub-schemas'],
    };
    for (const s of sources) {
      for (const m of codeOf(s.text).matchAll(/from '([^']+)'/g)) {
        const spec = m[1] as string;
        if (spec.startsWith('.')) continue;
        const ok = allowed.has(spec) || (perFile[s.file] ?? []).includes(spec);
        expect(ok, `${s.file} imports ${spec}`).toBe(true);
      }
    }
  });
});

/**
 * Import closure of everything the pilot's real wiring loads (dynamic imports included,
 * type-only imports excluded: tsc erases them). It must never reach the model client or a
 * model SDK; the only `ai/` file in it is the constants module `ai/thinking.ts`.
 */
describe('static: the import closure of the real wiring has no model client', () => {
  const root = path.resolve(__dirname, '../../../..');
  const entries = ['src/casting/t3/real-pilot-io.ts', 'src/casting/t3/real-reader.ts'];

  const closure = (starts: readonly string[]): string[] => {
    const seen = new Set<string>();
    const queue = starts.map((f) => path.resolve(root, f));
    const resolve = (from: string, spec: string): string | null => {
      const base = path.resolve(path.dirname(from), spec);
      for (const c of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(c)) return c;
      return null;
    };
    while (queue.length > 0) {
      const f = queue.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = codeOf(fs.readFileSync(f, 'utf8')).replace(
        /import type [^;]*?from\s*'[^']+';?/gs,
        '',
      );
      for (const m of text.matchAll(/(?:from|import\()\s*'([^']+)'/g)) {
        const spec = m[1] as string;
        if (!spec.startsWith('.')) continue;
        const r = resolve(f, spec);
        if (r) queue.push(r);
      }
    }
    return [...seen].map((f) => path.relative(root, f)).sort();
  };

  it('reaches neither ai/gemini.client nor ai/index nor a model SDK', () => {
    // Walk from the lazily loaded modules (and from the targets of their dynamic imports).
    const reached = closure([
      ...entries,
      'src/drive/extract.ts',
      'src/drive/client.ts',
      'src/drive/subtree.ts',
      'src/drive/traversal.ts',
      'src/prisma.ts',
      'src/casting/t1/pg-adapters.ts',
      'src/casting/t2/backfill/pg-adapters.ts',
      'src/casting/identity/index.ts',
    ]);
    expect(reached.length).toBeGreaterThan(20);
    expect(reached.filter((f) => f.startsWith('src/ai/'))).toEqual(['src/ai/thinking.ts']);
    for (const f of reached) {
      const code = codeOf(fs.readFileSync(path.resolve(root, f), 'utf8'));
      expect(code, f).not.toMatch(/@google\/genai|gemini\.client|from '(\.\.\/)+ai'/);
    }
  });
});

describe('static: the ledger loader never reaches a model', () => {
  const loaderFiles = ['load.ts', 'load-args.ts', 'load-main.ts', 'pg-sink.ts'];
  const text = (f: string): string => codeOf(sources.find((s) => s.file === f)?.text ?? '');

  it('no loader file names the model client, the genai SDK, the real model or reader wiring', () => {
    for (const f of loaderFiles) {
      expect(text(f), f).not.toMatch(
        /real-llm|real-reader|gemini|@google\/genai|genai|from '(\.\.\/)+ai(\/[^']*)?'|drive\/extract|drive\/client/,
      );
    }
  });

  it('the loader core imports no config, Prisma, Drive or model code, not even lazily', () => {
    for (const f of ['load.ts', 'load-args.ts']) {
      expect(text(f), f).not.toMatch(/\bimport\(/);
      expect(text(f), f).not.toMatch(/real-|prisma|\.\.\/\.\.\/config|\.\.\/\.\.\/logger/);
    }
  });

  it('only load-main.ts has dynamic imports, and only of the roster, the sink and Prisma', () => {
    const targets = [...text('load-main.ts').matchAll(/import\('([^']+)'\)/g)]
      .map((m) => m[1])
      .sort();
    expect(targets).toEqual(['../../prisma', './pg-sink', './real-pilot-io', './real-pilot-io']);
    expect(text('pg-sink.ts')).not.toMatch(/\bimport\(/);
  });

  it('the import closure of the loader (dynamic imports included) has no model client', () => {
    const root = path.resolve(__dirname, '../../../..');
    const seen = new Set<string>();
    const queue = [
      'src/casting/t3/load-main.ts',
      'src/casting/t3/pg-sink.ts',
      'src/casting/t3/real-pilot-io.ts',
      'src/prisma.ts',
    ].map((f) => path.resolve(root, f));
    const resolve = (from: string, spec: string): string | null => {
      const base = path.resolve(path.dirname(from), spec);
      for (const c of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(c)) return c;
      return null;
    };
    while (queue.length > 0) {
      const f = queue.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      const code = codeOf(fs.readFileSync(f, 'utf8')).replace(
        /import type [^;]*?from\s*'[^']+';?/gs,
        '',
      );
      for (const m of code.matchAll(/(?:from|import\()\s*'([^']+)'/g)) {
        const spec = m[1] as string;
        if (!spec.startsWith('.')) continue;
        const r = resolve(f, spec);
        if (r) queue.push(r);
      }
    }
    const reached = [...seen].map((f) => path.relative(root, f)).sort();
    expect(reached.length).toBeGreaterThan(10);
    expect(reached).not.toContain('src/ai/gemini.client.ts');
    expect(reached).not.toContain('src/ai/index.ts');
    expect(reached).not.toContain('src/casting/t3/real-llm.ts');
    expect(reached).not.toContain('src/casting/t3/real-reader.ts');
    // Drive modules appear in this closure only through real-pilot-io.ts's listing function,
    // which the loader never calls (it uses `loadRosterIndex`); they are not a model either.
    // The loader does not import the stage runner or the response schema (which pulls the genai
    // type enum), and the only `ai/` file left in reach is the constants module.
    for (const f of ['run.ts', 'pilot.ts', 'schema.ts']) {
      expect(reached).not.toContain(`src/casting/t3/${f}`);
    }
    expect(reached.filter((f) => f.startsWith('src/ai/'))).toEqual(['src/ai/thinking.ts']);
    for (const f of reached) {
      expect(codeOf(fs.readFileSync(path.resolve(root, f), 'utf8')), f).not.toMatch(
        /@google\/genai|gemini\.client|from '(\.\.\/)+ai'/,
      );
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

describe('dynamic: the pilot driver in dry-run', () => {
  const ACCT = '22222222-2222-4222-8222-222222222222';
  const argv = (...extra: string[]): string[] => [
    '--account-id',
    ACCT,
    '--window-start',
    '2021-11-19',
    '--sample-size',
    '3',
    '--sample-seed',
    'seed',
    ...extra,
  ];

  async function load() {
    vi.resetModules();
    const evaluated = {
      llm: vi.fn(),
      client: vi.fn(),
      config: vi.fn(),
      reader: vi.fn(),
      io: vi.fn(),
    };
    vi.doMock('../../../ai/gemini.client', () => {
      evaluated.client();
      throw new Error('the real client must never be constructed here');
    });
    vi.doMock('../../../config', () => {
      evaluated.config();
      throw new Error('config must never be loaded here');
    });
    vi.doMock('../real-llm', () => {
      evaluated.llm();
      throw new Error('real-llm must never be loaded in a dry-run');
    });
    vi.doMock('../real-pilot-io', () => {
      evaluated.io();
      throw new Error('the live listing must not be loaded by this test');
    });
    // The reader is harmless to mock with a fake: a dry-run with --read-text may use it.
    vi.doMock('../real-reader', () => {
      evaluated.reader();
      return {
        createRealReader: () => ({
          read: async () => ({ kind: 'ok', text: 'synthetic text' }),
        }),
      };
    });
    const main = await import('../pilot-main');
    const { cand, GDOC } = await import('./helpers');
    const { buildRosterIndex } = await import('../../identity');
    const real = main.realIo();
    const io = {
      ...real,
      // The listing and the roster are the only real parts replaced: they need a database.
      loadCandidates: async () =>
        Array.from({ length: 6 }, (_, i) =>
          cand({
            fileId: `f-${i}`,
            name: `Brief qa${i}`,
            mimeType: GDOC,
            ancestors: ['root', `Folder qa${i}`],
            accountId: ACCT,
          }),
        ),
      loadRoster: async () => buildRosterIndex([]),
      print: () => undefined,
    };
    return { main, io, evaluated };
  }

  const unmock = (): void => {
    for (const m of [
      '../../../ai/gemini.client',
      '../../../config',
      '../real-llm',
      '../real-pilot-io',
      '../real-reader',
    ]) {
      vi.doUnmock(m);
    }
  };

  it('never evaluates the model client, config, real-llm or the reader (default dry-run)', async () => {
    const { main, io, evaluated } = await load();
    const code = await main.runPilotCli(argv(), io);
    expect(code).toBe(3);
    expect(evaluated.llm).not.toHaveBeenCalled();
    expect(evaluated.client).not.toHaveBeenCalled();
    expect(evaluated.config).not.toHaveBeenCalled();
    expect(evaluated.reader).not.toHaveBeenCalled();
    unmock();
  });

  it('with --read-text it may load the reader, and still never the model client', async () => {
    const { main, io, evaluated } = await load();
    const code = await main.runPilotCli(argv('--read-text'), io);
    expect(code).toBe(3);
    expect(evaluated.reader).toHaveBeenCalledTimes(1);
    expect(evaluated.llm).not.toHaveBeenCalled();
    expect(evaluated.client).not.toHaveBeenCalled();
    expect(evaluated.config).not.toHaveBeenCalled();
    unmock();
  });

  it('an apply that a guard refuses never evaluates the model client either', async () => {
    const { main, io, evaluated } = await load();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main.runPilotCli(
      argv('--apply', '--max-cells', '3', '--max-usd', '1', '--ledger-dir', '/etc'),
      { ...io, repoRoots: ['/etc'] },
    );
    err.mockRestore();
    expect(code).toBe(2);
    expect(evaluated.llm).not.toHaveBeenCalled();
    expect(evaluated.client).not.toHaveBeenCalled();
    unmock();
  });
});

describe('dynamic: the ledger loader with the client module poisoned', () => {
  const ACCT = '11111111-1111-4111-8111-111111111111';

  it('a dry-run and an apply never evaluate the model client, config, real-llm or the reader', async () => {
    vi.resetModules();
    const evaluated = { client: vi.fn(), config: vi.fn(), llm: vi.fn(), reader: vi.fn() };
    vi.doMock('../../../ai/gemini.client', () => {
      evaluated.client();
      throw new Error('the real client must never be constructed here');
    });
    vi.doMock('../../../config', () => {
      evaluated.config();
      throw new Error('config must never be loaded here');
    });
    vi.doMock('../real-llm', () => {
      evaluated.llm();
      throw new Error('real-llm must never be loaded by the loader');
    });
    vi.doMock('../real-reader', () => {
      evaluated.reader();
      throw new Error('the reader must never be loaded by the loader');
    });
    const fs2 = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs2.mkdtempSync(path.join(os.tmpdir(), 'load-poison-'));
    try {
      const { buildRosterIndex } = await import('../../identity');
      const { MemorySink } = await import('../index');
      const main = await import('../load-main');
      const dir = path.join(tmp, 'ledger');
      fs2.mkdirSync(dir);
      const sig = {
        accountId: ACCT,
        windowStart: '2021-11-19',
        variant: 'base',
        sampleSize: 1,
        seed: 's',
        promptVersion: 'v1',
        model: 'gemini-3.5-flash',
        thinkingLevel: 'LOW',
        capChars: 40000,
      };
      const version = 't3-v1:gemini-3.5-flash:low';
      fs2.writeFileSync(
        path.join(dir, 'header.json'),
        JSON.stringify({
          v: 1,
          createdAt: '2026-11-20T00:00:00.000Z',
          signature: sig,
          extractorVersion: version,
          sample: { fileIds: [] },
        }),
      );
      fs2.writeFileSync(
        path.join(dir, 'cells.jsonl'),
        JSON.stringify({
          v: 1,
          cellKey: 'k1',
          extractorVersion: version,
          at: '2026-11-20T00:00:00.000Z',
          status: 'ok',
          reason: null,
          candidate: { fileId: 'f1', accountId: ACCT, createdTime: null, projectRef: undefined },
          docClass: 'gdoc',
          contentHash: 'h',
          docType: 'other',
          truncated: false,
          sentChars: 10,
          attempts: 1,
          usage: null,
          mentions: [],
          sanitizeStats: null,
          groundingStats: null,
        }) + '\n',
      );
      const sink = new MemorySink();
      const io = {
        loadRoster: async () => buildRosterIndex([]),
        makeSink: async () => sink,
        repoRoots: [path.join(tmp, 'repo')],
        print: () => undefined,
      };
      const argv = ['--ledger-dir', dir, '--account-id', ACCT];
      expect(await main.runLoadCli(argv, io)).toBe(3);
      expect(await main.runLoadCli([...argv, '--apply'], io)).toBe(0);
      expect(evaluated.client).not.toHaveBeenCalled();
      expect(evaluated.config).not.toHaveBeenCalled();
      expect(evaluated.llm).not.toHaveBeenCalled();
      expect(evaluated.reader).not.toHaveBeenCalled();
    } finally {
      fs2.rmSync(tmp, { recursive: true, force: true });
      for (const m of [
        '../../../ai/gemini.client',
        '../../../config',
        '../real-llm',
        '../real-reader',
      ]) {
        vi.doUnmock(m);
      }
    }
  });
});
