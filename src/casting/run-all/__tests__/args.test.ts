import { describe, expect, it } from 'vitest';
import { parseCastingArgs } from '../args';
import { ACCT, PLAN_FLAGS, RUN_ID, WINDOW, castingArgs, paidFlags } from './helpers';

describe('casting-run arguments', () => {
  it('defaults: PLAN, all five stages in the fixed order, nothing applied', () => {
    const a = castingArgs();
    expect(a).toMatchObject({ apply: false, applyT3: false, accountId: ACCT, windowStart: WINDOW });
    expect(a.stages).toEqual(['t1', 't2', 't3', 'load', 'fusion']);
  });

  it('--stages selects a subset and never reorders', () => {
    expect(castingArgs('--stages', 'fusion,t1').stages).toEqual(['t1', 'fusion']);
    expect(() => castingArgs('--stages', 't1,nope')).toThrow(/unknown stage/);
  });

  it('exactly one account, a valid uuid, and a window start are required', () => {
    expect(() => parseCastingArgs(['--window-start', WINDOW, ...PLAN_FLAGS.slice(4)])).toThrow(
      /account-id/,
    );
    expect(() => castingArgs('--account-id', ACCT)).toThrow(/given twice/);
    expect(() => parseCastingArgs(['--account-id', 'nope', '--window-start', WINDOW])).toThrow(
      /account-id/,
    );
    expect(() => parseCastingArgs(['--account-id', ACCT, ...PLAN_FLAGS.slice(4)])).toThrow(
      /window-start/,
    );
    expect(() =>
      parseCastingArgs([
        '--account-id',
        ACCT,
        '--window-start',
        '2021-13-45',
        ...PLAN_FLAGS.slice(4),
      ]),
    ).toThrow(/window-start/);
  });

  it('unknown flags and stray arguments are errors', () => {
    expect(() => castingArgs('--aply')).toThrow(/unknown flag --aply/);
    expect(() => castingArgs('apply')).toThrow(/unexpected argument/);
    expect(() => castingArgs('--max-cell', '5')).toThrow(/unknown flag/);
    expect(() => castingArgs('--ledger-dir')).toThrow(/needs a value/);
  });

  it('--apply-t3 refuses without each of the six required flags', () => {
    const full = paidFlags('/abs/ledgers/one');
    for (const flag of ['--max-cells', '--max-usd', '--ledger-dir', '--expect-cells']) {
      const i = full.indexOf(flag);
      const without = full.filter((_, k) => k !== i && k !== i + 1);
      expect(() => castingArgs(...without), flag).toThrow(new RegExp(flag));
    }
    const noSize = ['--account-id', ACCT, '--window-start', WINDOW, '--sample-seed', 's', ...full];
    expect(() => parseCastingArgs(noSize)).toThrow(/sample-size/);
    const noSeed = ['--account-id', ACCT, '--window-start', WINDOW, '--sample-size', '5', ...full];
    expect(() => parseCastingArgs(noSeed)).toThrow(/sample-seed/);
  });

  it('the paid flags mean nothing without --apply-t3', () => {
    expect(() => castingArgs('--max-usd', '5')).toThrow(/only means something with --apply-t3/);
    expect(() => castingArgs('--max-cells', '5')).toThrow(/--apply-t3/);
    expect(() => castingArgs('--expect-cells', '5')).toThrow(/--apply-t3/);
    expect(() => castingArgs('--allow-repeat-paid')).toThrow(/--apply-t3/);
  });

  it('--apply alone is not --apply-t3', () => {
    const a = castingArgs('--apply', '--ledger-dir', '/abs/l');
    expect(a.apply).toBe(true);
    expect(a.applyT3).toBe(false);
  });

  it('the ledger dir must be absolute; --max-usd and counts must be positive', () => {
    expect(() => castingArgs(...paidFlags('rel/dir'))).toThrow(/absolute/);
    expect(() => castingArgs(...paidFlags('/abs/l').map((v) => (v === '5' ? '0' : v)))).toThrow();
    expect(() => castingArgs('--sample-size', '0')).toThrow(/given twice|>= 1/);
  });

  it('t3 in the stages needs a sample size and seed even in a PLAN; without t3 they are errors', () => {
    expect(() => parseCastingArgs(['--account-id', ACCT, '--window-start', WINDOW])).toThrow(
      /sample-size and --sample-seed/,
    );
    const noT3 = ['--account-id', ACCT, '--window-start', WINDOW, '--stages', 't1,t2'];
    expect(parseCastingArgs(noT3).stages).toEqual(['t1', 't2']);
    expect(() => parseCastingArgs([...noT3, '--model', 'm'])).toThrow(/t3 in --stages/);
    expect(() => parseCastingArgs([...noT3, '--apply-t3'])).toThrow(/needs t3/);
  });

  it('--apply with the load stage needs a ledger dir', () => {
    expect(() => castingArgs('--apply')).toThrow(/needs --ledger-dir/);
    expect(() => castingArgs('--apply', '--stages', 't1,t2,t3,fusion')).not.toThrow();
  });

  it('--resume: only t1 and t2, uuids, only with --apply, only for staged stages', () => {
    expect(
      castingArgs('--apply', '--ledger-dir', '/abs/l', '--resume', `t1=${RUN_ID}`).resume,
    ).toEqual({
      t1: RUN_ID,
    });
    expect(() => castingArgs('--resume', `t1=${RUN_ID}`)).toThrow(/needs --apply/);
    expect(() => castingArgs('--apply', '--ledger-dir', '/abs/l', '--resume', 't3=abc')).toThrow(
      /t1=<uuid>/,
    );
    expect(() => castingArgs('--apply', '--stages', 't2,t3', '--resume', `t1=${RUN_ID}`)).toThrow(
      /not in --stages/,
    );
  });

  it('repeatable flags de-duplicate; bad dates are refused', () => {
    const a = castingArgs('--agency-domain', 'A.example', '--agency-domain', 'a.example');
    expect(a.agencyDomains).toEqual(['a.example']);
    expect(() => castingArgs('--unknown-start-date', '2000-1-1')).toThrow(/YYYY-MM-DD/);
  });
});
