/**
 * `casting-run --incremental` (S9): arguments, argv, change-probe gating, the by-cell paid-twice
 * check and the quiet-day exit code. Fake stages only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PILOT_HEADER_FILE } from '../../t3/ledger';
import { parseCastingArgs, windowStartFromYears } from '../args';
import { buildPlan, INCREMENTAL_DEFAULT_SEED, INCREMENTAL_PLAN_SAMPLE_SIZE } from '../plan';
import { EXIT, runCasting, type ChangeProbeResult } from '../run';
import { ACCT, GOOD_ENV, fakes, records, tmpDir, type Fakes } from './helpers';

let tmp: string;
let dir: string;
let f: Fakes;
beforeEach(() => {
  tmp = tmpDir();
  dir = path.join(tmp, 'ledgers', 'd2');
  f = fakes();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const BASE = ['--account-id', ACCT, '--incremental', '--window-start', '2021-11-20'];
const FREE = ['--stages', 't1,t2,load,fusion'];
const args = (...extra: string[]) => parseCastingArgs([...BASE, ...extra]);
const called = (): string[] => f.calls.map((c) => c.stage);
const probe = (r: ChangeProbeResult) => async (): Promise<ChangeProbeResult> => r;
const QUIET: ChangeProbeResult = { changed: false, reason: 'no_change', filesChanged: 0 };
const CHANGED: ChangeProbeResult = { changed: true, reason: 'changed', filesChanged: 3 };
const t3Apply = (): string[] => [
  '--ledger-dir',
  dir,
  '--apply-t3',
  '--max-cells',
  '5',
  '--max-usd',
  '5',
  '--expect-cells',
  '2',
];

describe('arguments', () => {
  it('--incremental with t3 needs --ledger-dir; sample flags become optional; expect-cells may be 0', () => {
    expect(() => args()).toThrow(/--ledger-dir/);
    expect(args('--ledger-dir', dir)).toMatchObject({
      incremental: true,
      sampleSize: null,
      sampleSeed: null,
    });
    expect(() => args('--ledger-dir', 'rel')).toThrow(/absolute/);
    const zero = args(
      '--ledger-dir',
      dir,
      '--apply-t3',
      '--max-cells',
      '5',
      '--max-usd',
      '5',
      '--expect-cells',
      '0',
    );
    expect(zero.expectCells).toBe(0);
    // Without --incremental, 0 stays invalid and the sample flags stay required.
    expect(() =>
      parseCastingArgs([
        '--account-id',
        ACCT,
        '--window-start',
        '2021-11-20',
        '--sample-size',
        '5',
        '--sample-seed',
        's',
        '--expect-cells',
        '0',
      ]),
    ).toThrow(/expect-cells/);
    expect(() => parseCastingArgs(['--account-id', ACCT, '--window-start', '2021-11-20'])).toThrow(
      /sample-size/,
    );
  });

  it('the paid flags stay required with --incremental', () => {
    expect(() => args('--ledger-dir', dir, '--apply-t3')).toThrow(
      /--max-cells.*--max-usd.*--expect-cells/,
    );
  });

  it('--window-years slides the window, needs --incremental, excludes --window-start', () => {
    const now = new Date('2026-11-23T10:00:00Z');
    const a = parseCastingArgs(
      ['--account-id', ACCT, '--incremental', '--window-years', '5', '--ledger-dir', dir],
      now,
    );
    expect(a).toMatchObject({ windowStart: '2021-11-23', windowYears: 5 });
    expect(windowStartFromYears(new Date('2024-02-29T00:00:00Z'), 5)).toBe('2019-03-01');
    expect(() => parseCastingArgs([...BASE, '--window-years', '5', '--ledger-dir', dir])).toThrow(
      /not both/,
    );
    expect(() =>
      parseCastingArgs([
        '--account-id',
        ACCT,
        '--window-years',
        '5',
        '--sample-size',
        '1',
        '--sample-seed',
        's',
      ]),
    ).toThrow(/needs --incremental/);
  });

  it('a free-stage incremental job needs no ledger dir and no sample flags', () => {
    const a = args(...FREE, '--apply');
    expect(a).toMatchObject({ incremental: true, apply: true, ledgerDir: null });
  });
});

describe('argv per stage', () => {
  it('t3 gets --incremental and a derived sample: whole delta in plan, max-cells in apply', () => {
    const planned = buildPlan(args('--ledger-dir', dir), undefined).stages.find(
      (s) => s.stage === 't3',
    )!;
    expect(planned.argv).toContain('--incremental');
    expect(planned.argv[planned.argv.indexOf('--sample-size') + 1]).toBe(
      String(INCREMENTAL_PLAN_SAMPLE_SIZE),
    );
    expect(planned.argv[planned.argv.indexOf('--sample-seed') + 1]).toBe(INCREMENTAL_DEFAULT_SEED);
    const paid = buildPlan(args(...t3Apply()), undefined).stages.find((s) => s.stage === 't3')!;
    expect(paid.argv[paid.argv.indexOf('--sample-size') + 1]).toBe('5');
    expect(paid.pilotArgs?.incremental).toBe(true);
  });
});

describe('quiet and changed days (--apply, free stages)', () => {
  it('no change: t1, t2 and fusion are skipped, nothing is written, exit 0 (not "plan printed")', async () => {
    const out = await runCasting(args(...FREE, '--apply'), f.deps({ changeProbe: probe(QUIET) }));
    expect(called()).toEqual([]);
    expect(out.exitCode).toBe(EXIT.ok);
    const rec = records(f.lines);
    expect(rec.find((r) => r['msg'] === 'casting-run change probe')).toMatchObject({
      changed: false,
      reason: 'no_change',
    });
    expect(
      rec.filter((r) => r['msg'] === 'casting-run stage skipped').map((r) => r['stage']),
    ).toEqual(['t1', 't2', 'load', 'fusion']);
  });

  it('a change runs the free stages in order; load has no ledger and is skipped', async () => {
    const out = await runCasting(args(...FREE, '--apply'), f.deps({ changeProbe: probe(CHANGED) }));
    expect(called()).toEqual(['t1', 't2', 'fusion']);
    expect(out.exitCode).toBe(EXIT.ok);
    expect(f.calls.every((c) => c.argv.includes('--apply') || c.stage === 'load')).toBe(true);
  });

  it('no probe, or a probe that throws, means "changed": the idempotent stages run', async () => {
    await runCasting(args(...FREE, '--apply'), f.deps());
    expect(called()).toEqual(['t1', 't2', 'fusion']);
    f.calls.length = 0;
    await runCasting(
      args(...FREE, '--apply'),
      f.deps({
        changeProbe: async () => {
          throw new Error('db down');
        },
      }),
    );
    expect(called()).toEqual(['t1', 't2', 'fusion']);
    const reasons = records(f.lines)
      .filter((r) => r['msg'] === 'casting-run change probe')
      .map((r) => r['reason']);
    expect(reasons).toEqual(['no_probe', 'probe_error']);
  });

  it('plan mode (no --apply) never asks the probe and dry-runs every stage', async () => {
    let asked = false;
    const out = await runCasting(
      args(...FREE),
      f.deps({
        changeProbe: async () => {
          asked = true;
          return QUIET;
        },
      }),
    );
    expect(asked).toBe(false);
    expect(called()).toEqual(['t1', 't2', 'fusion']);
    expect(f.calls.every((c) => !c.argv.includes('--apply'))).toBe(true);
    expect(out.exitCode).toBe(EXIT.plan);
  });

  it('a failing free stage still fails the run on a changed day', async () => {
    f.codes.t1 = 1;
    const out = await runCasting(args(...FREE, '--apply'), f.deps({ changeProbe: probe(CHANGED) }));
    expect(out).toMatchObject({ exitCode: EXIT.failed, decidedBy: 't1' });
  });

  it('the plan line records the window cutoff and the incremental flag', async () => {
    await runCasting(args(...FREE), f.deps());
    const plan = records(f.lines).find((r) => r['msg'] === 'casting-run plan')!;
    expect(plan).toMatchObject({
      windowStart: '2021-11-20',
      windowCutoff: '2021-11-20',
      windowYears: null,
      incremental: true,
    });
  });
});

describe('quiet day with the paid stage on the line', () => {
  it('the probe does not gate t3; a ledger written today makes load and fusion run', async () => {
    f.t3Info = { cells: 2, model: 'gemini-3.5-flash', baseCostUsd: 0.05, baseComplete: true };
    const t3 = f.stages.t3;
    (f.stages as { t3: typeof t3 }).t3 = async (argv, hooks) => {
      const code = await t3(argv, hooks);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, PILOT_HEADER_FILE), '{}');
      return code;
    };
    const out = await runCasting(
      args('--apply', ...t3Apply()),
      f.deps({ env: GOOD_ENV, changeProbe: probe(QUIET) }),
    );
    expect(called()).toEqual(['t3', 'load', 'fusion']);
    expect(out.exitCode).toBe(EXIT.ok);
  });

  it('a quiet paid day with 0 cells: t3 runs, no ledger appears, load and fusion are skipped', async () => {
    f.t3Info = { cells: 0, model: 'gemini-3.5-flash', baseCostUsd: 0, baseComplete: true };
    const out = await runCasting(
      args(
        '--apply',
        '--ledger-dir',
        dir,
        '--apply-t3',
        '--max-cells',
        '5',
        '--max-usd',
        '5',
        '--expect-cells',
        '0',
      ),
      f.deps({ env: GOOD_ENV, changeProbe: probe(QUIET) }),
    );
    expect(called()).toEqual(['t3']);
    expect(out.exitCode).toBe(EXIT.ok);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('the paid guards still apply to an incremental run', () => {
  it('--expect-cells must equal the PROPOSAL cells', async () => {
    f.t3Info = { cells: 3, model: 'gemini-3.5-flash', baseCostUsd: 0.05, baseComplete: true };
    const out = await runCasting(args(...t3Apply()), f.deps({ env: GOOD_ENV }));
    expect(out).toMatchObject({ exitCode: EXIT.refused, decidedBy: 't3' });
  });

  it('the base estimate above --max-usd refuses', async () => {
    f.t3Info = { cells: 2, model: 'gemini-3.5-flash', baseCostUsd: 9, baseComplete: true };
    const out = await runCasting(args(...t3Apply()), f.deps({ env: GOOD_ENV }));
    expect(out.exitCode).toBe(EXIT.refused);
  });

  it('the model preflight still fails closed without GEMINI_USE_ENTERPRISE', async () => {
    const out = await runCasting(args(...t3Apply()), f.deps({ env: {} }));
    expect(out).toMatchObject({ exitCode: EXIT.refused, decidedBy: 'preflight' });
    expect(f.calls).toHaveLength(0);
  });

  it('paid-twice by cell: a sibling that paid one of these cells refuses; one that did not does not', async () => {
    const sibling = path.join(path.dirname(dir), 'd1');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(
      path.join(sibling, PILOT_HEADER_FILE),
      JSON.stringify({ v: 1, signature: { accountId: ACCT } }),
    );
    fs.writeFileSync(
      path.join(sibling, 'cells.jsonl'),
      JSON.stringify({ v: 1, status: 'ok', cellKey: 'k-paid' }) + '\n',
    );

    f.t3Info = {
      cells: 2,
      model: 'gemini-3.5-flash',
      baseCostUsd: 0.05,
      baseComplete: true,
      cellKeys: ['k-new-1', 'k-new-2'],
    };
    const fine = await runCasting(args(...t3Apply(), '--stages', 't3'), f.deps({ env: GOOD_ENV }));
    expect(fine.exitCode).toBe(EXIT.ok);

    f.t3Info = {
      cells: 2,
      model: 'gemini-3.5-flash',
      baseCostUsd: 0.05,
      baseComplete: true,
      cellKeys: ['k-new-1', 'k-paid'],
    };
    const twin = await runCasting(args(...t3Apply(), '--stages', 't3'), f.deps({ env: GOOD_ENV }));
    expect(twin).toMatchObject({ exitCode: EXIT.refused, decidedBy: 't3' });
    expect(f.lines.join('\n')).toMatch(/already paid for at least one of these cells/);

    const allowed = await runCasting(
      args(...t3Apply(), '--stages', 't3', '--allow-repeat-paid'),
      f.deps({ env: GOOD_ENV }),
    );
    expect(allowed.exitCode).toBe(EXIT.ok);
  });
});
