/**
 * Static guards: the orchestrator core can never construct a model client, a database client or a
 * Drive client. Only real-stages.ts (and main.ts for the final disconnect) may load stage code, and
 * only through dynamic imports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '..');
const text = (f: string): string =>
  fs
    .readFileSync(path.join(dir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

const CORE = ['args.ts', 'plan.ts', 'run.ts', 'guards.ts', 'runlog.ts'];

describe('the hermetic core', () => {
  it('imports no config, Prisma, logger, ai index, model client, Drive or real wiring', () => {
    for (const f of CORE) {
      const code = text(f);
      expect(code, f).not.toMatch(/\bimport\(/);
      expect(code, f).not.toMatch(
        /gemini|@google\/genai|@prisma|from '(\.\.\/)+(config|prisma|logger|ai|ai\/index)'|\/real-|drive\/|\/main'/,
      );
    }
  });

  it('imports only relative modules, node:fs and node:path', () => {
    for (const f of CORE) {
      for (const m of text(f).matchAll(/from '([^']+)'/g)) {
        const spec = m[1] as string;
        expect(
          spec.startsWith('.') || spec === 'node:fs' || spec === 'node:path',
          `${f}: ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('real-stages.ts has only dynamic imports of stage code; its static imports are types', () => {
    const code = text('real-stages.ts');
    expect(code).not.toMatch(/^import (?!type)[^;]*from/m);
    expect([...code.matchAll(/await import\('([^']+)'\)/g)].map((m) => m[1]).sort()).toEqual([
      '../fusion/main',
      '../t1/main',
      '../t2/main',
      '../t3/load-main',
      '../t3/pilot-main',
    ]);
  });

  it('only main.ts and real-stages.ts have a dynamic import at all', () => {
    const hits = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\bimport\(/.test(text(f)))
      .sort();
    expect(hits).toEqual(['main.ts', 'real-stages.ts']);
  });
});
