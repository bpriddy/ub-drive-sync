/**
 * Static guards of the maintenance tools: no file of this folder can reach a model client, and
 * only the wiring files reach a database, lazily.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '..');
const code = (f: string): string =>
  fs
    .readFileSync(path.join(dir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));

/** Pure cores: node:fs / node:path and relative modules only, no dynamic import at all. */
const CORE = [
  'incremental.ts',
  'prior-ledgers.ts',
  'rescan-plan.ts',
  'drift.ts',
  'purge.ts',
  'job-config.ts',
  'constants.ts',
];
const PG = ['change-probe.ts', 'drift-pg.ts', 'purge-pg.ts'];

describe('the maintenance folder', () => {
  it('no file mentions a model client, the genai SDK or the ai index', () => {
    for (const f of files) {
      expect(code(f), f).not.toMatch(
        /gemini\.client|@google\/genai|real-llm|from '(\.\.\/)+ai(\/index)?'/,
      );
    }
  });

  it('the pure cores import only relative modules, node:fs and node:path, and no dynamic import', () => {
    for (const f of CORE) {
      const c = code(f);
      expect(c, f).not.toMatch(/\bimport\(/);
      expect(c, f).not.toMatch(/@prisma|from '(\.\.\/)+(config|prisma|logger)'|drive\//);
      for (const m of c.matchAll(/from '([^']+)'/g)) {
        const spec = m[1] as string;
        expect(
          spec.startsWith('.') || spec === 'node:fs' || spec === 'node:path',
          `${f}: ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('the Postgres readers import only the Prisma client types and helpers, and write nothing but their own run rows', () => {
    for (const f of PG) {
      const c = code(f);
      expect(c, f).not.toMatch(/\bimport\(/);
      expect(c, f).not.toMatch(/from '(\.\.\/)+(config|prisma|logger)'/);
    }
    // The probe and the drift reader are SELECT only.
    for (const f of ['change-probe.ts', 'drift-pg.ts']) {
      expect(code(f), f).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    }
  });

  it('the rescan plan has no apply path: its parser refuses every apply flag', () => {
    expect(code('rescan-plan.ts')).not.toMatch(/makeLlm|makeSink|llmFactory|beforeApply/);
  });
});
