/**
 * Guard: neither the tests nor a dry-run can construct the real Drive Activity
 * client, the real stats writer, the database client or the config.
 *  1. static: only real-ports.ts (lazily) and main.ts mention those modules;
 *  2. dynamic: with the modules poisoned, importing the public surface and
 *     running dry-run and confirm on fakes never evaluates them;
 *  3. real-ports.ts loads them only when a function is called.
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

describe('static', () => {
  it('only real-ports.ts mentions the forward Activity client and writer, and only dynamically', () => {
    const hits = sources
      .filter((s) => /forward\/(activity|stats|people)/.test(codeOf(s.text)))
      .map((s) => s.file);
    expect(hits).toEqual(['real-ports.ts']);
    const real = codeOf(sources.find((s) => s.file === 'real-ports.ts')!.text);
    expect(real).not.toMatch(/^import .*forward\//m);
    expect(real).toMatch(/await import\('\.\.\/\.\.\/\.\.\/forward\/activity'\)/);
    expect(real).toMatch(/await import\('\.\.\/\.\.\/\.\.\/forward\/stats'\)/);
  });

  it('only main.ts imports prisma, the logger, config or googleapis', () => {
    const forbidden = /from '((\.\.\/)+(prisma|logger|config|workspace)|googleapis)'/;
    const hits = sources.filter((s) => forbidden.test(codeOf(s.text))).map((s) => s.file);
    expect(hits).toEqual(['main.ts']);
  });

  it('forward/people (the People API resolver) is imported by nobody', () => {
    const hits = sources
      .filter((s) => codeOf(s.text).includes('forward/people'))
      .map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('only real-ports.ts has a dynamic import; the public index does not re-export it', () => {
    const hits = sources.filter((s) => /\bimport\(/.test(codeOf(s.text))).map((s) => s.file);
    expect(hits).toEqual(['real-ports.ts']);
    expect(codeOf(sources.find((s) => s.file === 'index.ts')!.text)).not.toMatch(/real-ports|main/);
  });

  it('non-test sources import only relative modules, node builtins or @prisma/client', () => {
    const allowed = new Set(['node:crypto', '@prisma/client']);
    for (const s of sources.filter((x) => x.file !== 'main.ts')) {
      for (const m of codeOf(s.text).matchAll(/from '([^']+)'/g)) {
        const spec = m[1] as string;
        if (spec.startsWith('.')) continue;
        expect(allowed.has(spec), `${s.file} imports ${spec}`).toBe(true);
      }
    }
  });
});

describe('dynamic', () => {
  const poisoned = [
    'forward/activity',
    'forward/stats',
    'forward/people',
    'prisma',
    'config',
    'logger',
  ];

  it('dry-run and confirm on fakes never evaluate the real modules', async () => {
    vi.resetModules();
    const evaluated = vi.fn();
    for (const m of poisoned) {
      vi.doMock(`../../../../${m}`, () => {
        evaluated();
        throw new Error(`${m} must never be loaded here`);
      });
    }
    vi.doMock('googleapis', () => {
      evaluated();
      throw new Error('googleapis must never be loaded here');
    });
    const b = await import('../index');
    const f = await import('./fixtures');
    const deps = {
      existing: new f.FakeExisting(),
      accounts: new f.FakeAccounts(),
      activity: new f.FakeActivity(),
      writer: new f.FakeWriter(),
      people: new f.FakePeople(),
      runs: new f.FakeRuns(),
    };
    const opts = { accountId: f.ACCOUNT, from: '2025-01-01', to: '2025-03-02', today: f.TODAY };
    expect((await b.runBackfill(deps, { ...opts, confirm: false })).mode).toBe('dry-run');
    expect((await b.runBackfill(deps, { ...opts, confirm: true })).mode).toBe('confirm');
    expect(evaluated).not.toHaveBeenCalled();
    for (const m of poisoned) vi.doUnmock(`../../../../${m}`);
    vi.doUnmock('googleapis');
  });

  it('real-ports loads the Activity client and the writer only when called', async () => {
    vi.resetModules();
    const evaluated = vi.fn();
    vi.doMock('../../../../forward/activity', () => {
      evaluated();
      throw new Error('poisoned');
    });
    vi.doMock('../../../../forward/stats', () => {
      evaluated();
      throw new Error('poisoned');
    });
    const mod = await import('../real-ports');
    const source = mod.createRealActivitySource();
    const writer = mod.createRealStatsWriter();
    expect(evaluated).not.toHaveBeenCalled();
    await expect(source.foldWindow('r', 'a', 'b')).rejects.toThrow(/poisoned|error when mocking/);
    await expect(
      writer.replaceWindow({
        accountId: 'a',
        syncRunId: 's',
        day: '2025-01-01',
        tallies: new Map(),
        actorEmailBy: new Map(),
      }),
    ).rejects.toThrow(/poisoned|error when mocking/);
    expect(evaluated).toHaveBeenCalledTimes(2);
    vi.doUnmock('../../../../forward/activity');
    vi.doUnmock('../../../../forward/stats');
  });
});
