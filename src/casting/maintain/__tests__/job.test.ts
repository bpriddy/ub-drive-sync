/**
 * The casting job (S9 task 6): free stages only by default; the paid stage needs two explicit
 * variables. Fake `casting-run` invocations only: no stage, database, Drive or model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCastingArgs } from '../../run-all/args';
import { buildPlan } from '../../run-all/plan';
import type { BeforeApplyInfo } from '../../t3/pilot';
import {
  FREE_STAGES,
  JOB_ENV,
  freeArgv,
  parseJobEnv,
  t3ApplyArgv,
  t3PlanArgv,
  type JobConfig,
} from '../job-config';
import { runJob, type JobIo } from '../job-main';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-24T03:00:00Z');
const BASE_ENV = { [JOB_ENV.accounts]: `${A1},${A2}` };
const T3_ENV = {
  ...BASE_ENV,
  [JOB_ENV.apply]: 'true',
  [JOB_ENV.t3Enabled]: 'true',
  [JOB_ENV.t3DailyMaxUsd]: '10',
  [JOB_ENV.t3LedgerDir]: '/mnt/casting-ledgers/',
};

const config = (env: Record<string, string>): JobConfig => {
  const r = parseJobEnv(env);
  if (!r.ok) throw new Error(r.reasons.join('; '));
  return r.config;
};
const reasons = (env: Record<string, string>): string[] => {
  const r = parseJobEnv(env);
  return r.ok ? [] : [...r.reasons];
};

describe('parseJobEnv', () => {
  it('defaults: free stages, writes off, window 5 years, paid stage off', () => {
    expect(config(BASE_ENV)).toMatchObject({
      accounts: [A1, A2],
      apply: false,
      windowYears: 5,
      unknownStartDates: [],
      t3: null,
    });
  });

  it('no account is an error: nothing is enabled by default', () => {
    expect(reasons({})).toEqual([expect.stringMatching(/no account is enabled/)]);
    expect(reasons({ [JOB_ENV.accounts]: 'not-a-uuid' })).toEqual([
      expect.stringMatching(/not a uuid/),
    ]);
  });

  it('flags are strict: a typo refuses, it does not fall back', () => {
    expect(reasons({ ...BASE_ENV, [JOB_ENV.apply]: 'yes' })).toEqual([
      expect.stringContaining('"true" or "false"'),
    ]);
    expect(reasons({ ...BASE_ENV, [JOB_ENV.t3Enabled]: '1' })).toEqual([
      expect.stringContaining('"true" or "false"'),
    ]);
    expect(config({ ...BASE_ENV, [JOB_ENV.apply]: 'false' }).apply).toBe(false);
    expect(config({ ...BASE_ENV, [JOB_ENV.apply]: 'true' }).apply).toBe(true);
  });

  it('window years and placeholder dates are validated', () => {
    expect(config({ ...BASE_ENV, [JOB_ENV.windowYears]: '3' }).windowYears).toBe(3);
    expect(reasons({ ...BASE_ENV, [JOB_ENV.windowYears]: '0' })).toHaveLength(1);
    expect(reasons({ ...BASE_ENV, [JOB_ENV.windowYears]: '5.5' })).toHaveLength(1);
    expect(reasons({ ...BASE_ENV, [JOB_ENV.unknownStartDates]: '2020-01-01,never' })).toHaveLength(
      1,
    );
  });

  describe('the paid stage needs the enable flag AND the budget (and writes on, and a ledger dir)', () => {
    it('the enable flag alone refuses the whole job', () => {
      const r = reasons({ ...BASE_ENV, [JOB_ENV.t3Enabled]: 'true' });
      expect(r.join(' ')).toMatch(/needs CASTING_T3_DAILY_MAX_USD/);
    });
    it('the budget alone leaves the paid stage off, with a note', () => {
      const c = config({
        ...BASE_ENV,
        [JOB_ENV.t3DailyMaxUsd]: '10',
        [JOB_ENV.apply]: 'true',
        [JOB_ENV.t3LedgerDir]: '/x',
      });
      expect(c.t3).toBeNull();
      expect(c.notes.join(' ')).toMatch(/paid stage stays off/);
    });
    it('both without CASTING_JOB_APPLY, or without a persistent ledger dir, refuse', () => {
      expect(reasons({ ...T3_ENV, [JOB_ENV.apply]: 'false' }).join(' ')).toMatch(
        /needs CASTING_JOB_APPLY=true/,
      );
      expect(reasons({ ...T3_ENV, [JOB_ENV.t3LedgerDir]: 'relative/dir' }).join(' ')).toMatch(
        /absolute/,
      );
      const { [JOB_ENV.t3LedgerDir]: _gone, ...noDir } = T3_ENV;
      void _gone;
      expect(reasons(noDir).join(' ')).toMatch(/CASTING_T3_LEDGER_DIR/);
    });
    it('a bad budget refuses', () => {
      for (const bad of ['0', '-1', 'ten', 'NaN']) {
        expect(reasons({ ...T3_ENV, [JOB_ENV.t3DailyMaxUsd]: bad }).join(' ')).toMatch(
          /number > 0/,
        );
      }
    });
    it('both set: the paid stage is on, the ledger base is normalised', () => {
      expect(config(T3_ENV).t3).toEqual({ dailyMaxUsd: 10, ledgerBase: '/mnt/casting-ledgers' });
    });
  });
});

describe('argv: what the job can ask casting-run for', () => {
  it('the free pass never names t3 and never carries a paid flag; it parses with the real parsers', () => {
    expect(FREE_STAGES).toEqual(['t1', 't2', 'load', 'fusion']);
    for (const env of [BASE_ENV, T3_ENV]) {
      const argv = freeArgv(config(env), A1);
      expect(argv.join(' ')).not.toMatch(
        /t3|--apply-t3|--max-usd|--max-cells|--expect-cells|--ledger-dir/,
      );
      const args = parseCastingArgs(argv, NOW);
      expect(args).toMatchObject({
        incremental: true,
        windowYears: 5,
        windowStart: '2021-11-24',
        applyT3: false,
      });
      expect(args.stages).toEqual(['t1', 't2', 'load', 'fusion']);
      expect(buildPlan(args, undefined).stages.map((s) => s.stage)).toEqual([
        't1',
        't2',
        'load',
        'fusion',
      ]);
    }
    expect(freeArgv(config(BASE_ENV), A1)).not.toContain('--apply');
    expect(freeArgv(config({ ...BASE_ENV, [JOB_ENV.apply]: 'true' }), A1)).toContain('--apply');
  });

  it('the paid pass is built from a plan and parses with the real parsers', () => {
    const c = config(T3_ENV);
    const plan = parseCastingArgs(t3PlanArgv(c, A1, `/mnt/l/${A1}/2026-11-24`), NOW);
    expect(plan).toMatchObject({ stages: ['t3'], apply: false, applyT3: false });
    const paid = parseCastingArgs(
      t3ApplyArgv(c, A1, `/mnt/l/${A1}/2026-11-24`, { cells: 4, maxUsd: 5 }),
      NOW,
    );
    expect(paid).toMatchObject({
      apply: true,
      applyT3: true,
      maxCells: 4,
      expectCells: 4,
      maxUsd: 5,
    });
    expect(paid.stages).toEqual(['t1', 't2', 't3', 'load', 'fusion']);
  });
});

interface Call {
  argv: string[];
}

function rig(
  env: Record<string, string>,
  behave: (argv: string[], onProposal?: (i: BeforeApplyInfo) => void) => number,
) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const io: JobIo = {
    casting: async (argv, onProposal) => {
      calls.push({ argv: [...argv] });
      return behave([...argv], onProposal);
    },
    env,
    now: () => NOW,
    out: (l) => lines.push(l),
  };
  return { io, calls, lines };
}
const proposal = (cells: number, base: number, complete = true): BeforeApplyInfo => ({
  cells,
  model: 'gemini-3.5-flash',
  baseCostUsd: base,
  baseComplete: complete,
});

describe('runJob', () => {
  it('a bad configuration runs nothing and exits 2', async () => {
    const r = rig({}, () => 0);
    expect(await runJob(r.io)).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.lines.join('\n')).toContain('casting-job refused');
  });

  it('default: one free pass per account, and no call can reach the model', async () => {
    const r = rig(BASE_ENV, () => 3);
    expect(await runJob(r.io)).toBe(0); // plan-only is a clean finish
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      expect(c.argv).toContain('t1,t2,load,fusion');
      expect(c.argv.join(' ')).not.toMatch(/--apply-t3|--max-usd|t3/);
    }
  });

  it('a budget without the enable flag changes nothing', async () => {
    const r = rig({ ...BASE_ENV, [JOB_ENV.t3DailyMaxUsd]: '50', [JOB_ENV.apply]: 'true' }, () => 0);
    await runJob(r.io);
    expect(r.calls).toHaveLength(2);
    expect(r.calls.every((c) => !c.argv.includes('--apply-t3'))).toBe(true);
  });

  it('paid stage on: plan first, then one paid pass per account that has cells, within its share', async () => {
    const r = rig(T3_ENV, (argv, onProposal) => {
      if (argv.includes('--stages') && argv[argv.indexOf('--stages') + 1] === 't3') {
        onProposal?.(proposal(argv[1] === A1 ? 4 : 0, argv[1] === A1 ? 0.3 : 0));
        return 3;
      }
      return 0;
    });
    expect(await runJob(r.io)).toBe(0);
    const [plan1, paid1, plan2, free2] = r.calls.map((c) => c.argv);
    expect(plan1).toContain('--ledger-dir');
    expect(plan1?.[plan1.indexOf('--ledger-dir') + 1]).toBe(
      `/mnt/casting-ledgers/${A1}/2026-11-24`,
    );
    expect(plan1).not.toContain('--apply');
    expect(plan1).not.toContain('--apply-t3');
    // Paid pass for the account with cells: the plan's numbers, the account's share of 10 split in two.
    expect(paid1).toEqual(
      expect.arrayContaining([
        '--apply-t3',
        '--expect-cells',
        '4',
        '--max-cells',
        '4',
        '--max-usd',
        '5',
      ]),
    );
    // The account with nothing to pay gets the free pass only.
    expect(plan2).toContain(A2);
    expect(free2?.join(' ')).not.toMatch(/--apply-t3|t3/);
    expect(r.calls).toHaveLength(4);
  });

  it('an estimate above the account share, or an incomplete one, is not run', async () => {
    for (const info of [proposal(4, 12), proposal(4, 1, false)]) {
      const r = rig({ ...T3_ENV, [JOB_ENV.accounts]: A1 }, (argv, onProposal) => {
        if (argv.includes('--ledger-dir') && !argv.includes('--apply-t3')) {
          onProposal?.(info);
          return 3;
        }
        return 0;
      });
      await runJob(r.io);
      expect(r.calls.some((c) => c.argv.includes('--apply-t3'))).toBe(false);
      expect(r.calls).toHaveLength(2); // the plan, then the free pass
      expect(r.lines.join('\n')).toContain(
        'not run: no complete estimate within this account share',
      );
    }
  });

  it('a plan that failed or reported nothing falls back to the free pass, never to a paid one', async () => {
    const r = rig({ ...T3_ENV, [JOB_ENV.accounts]: A1 }, () => 1);
    expect(await runJob(r.io)).toBe(1);
    expect(r.calls.some((c) => c.argv.includes('--apply-t3'))).toBe(false);
  });

  it('exit code: the most serious failure of any account, one failure does not hide the next account', async () => {
    const codes = [2, 1];
    const r = rig(BASE_ENV, () => codes.shift() ?? 0);
    expect(await runJob(r.io)).toBe(1);
    expect(r.calls).toHaveLength(2);
    const r2 = rig(BASE_ENV, () => 4);
    expect(await runJob(r2.io)).toBe(4);
  });

  it('logs counts only: no account id in any line', async () => {
    const r = rig(T3_ENV, (argv, onProposal) => {
      onProposal?.(proposal(1, 0.1));
      return argv.includes('--apply-t3') ? 0 : 3;
    });
    await runJob(r.io);
    for (const l of r.lines) {
      expect(l).not.toContain(A1);
      expect(l).not.toContain(A2);
      expect(l).not.toContain('/mnt/');
    }
  });
});

describe('the job file creates nothing', () => {
  it('has no scheduler, terraform, gcloud or deploy reference in code', () => {
    for (const f of ['job-main.ts', 'job-config.ts']) {
      const code = fs
        .readFileSync(path.resolve(__dirname, '..', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      expect(code, f).not.toMatch(/scheduler|terraform|gcloud|jobs\.run|run\.googleapis/i);
    }
  });
});
