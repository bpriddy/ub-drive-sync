import { describe, expect, it } from 'vitest';
import { parseFusionArgs } from '../../fusion/args';
import { parseT1Args } from '../../t1/args';
import { parseT2Args } from '../../t2/args';
import { parseLoadArgs } from '../../t3/load-args';
import { parsePilotArgs } from '../../t3/pilot-args';
import { buildPlan, mergeAgencyDomains } from '../plan';
import { ACCT, RUN_ID, WINDOW, castingArgs, paidFlags } from './helpers';

const LEDGER = '/abs/ledgers/one';

describe('buildPlan', () => {
  it('one flag set gives every stage the same account, window and roster options', () => {
    const plan = buildPlan(
      castingArgs(
        '--apply',
        '--ledger-dir',
        LEDGER,
        '--agency-domain',
        'agency.example',
        '--unknown-start-date',
        '2000-01-01',
      ),
      undefined,
    );
    const by = Object.fromEntries(plan.stages.map((s) => [s.stage, s]));
    expect(parseT1Args(by['t1']!.argv)).toMatchObject({
      accountIds: [ACCT],
      windowStart: WINDOW,
      agencyDomains: ['agency.example'],
      apply: true,
    });
    expect(parseT2Args(by['t2']!.argv)).toMatchObject({
      windowStart: WINDOW,
      agencyDomains: ['agency.example'],
      unknownStartDates: ['2000-01-01'],
    });
    expect(parsePilotArgs(by['t3']!.argv)).toMatchObject({
      accountId: ACCT,
      windowStart: WINDOW,
      unknownStartDates: ['2000-01-01'],
      mode: 'dry-run',
    });
    expect(parseLoadArgs(by['load']!.argv)).toMatchObject({
      accountId: ACCT,
      agencyDomains: ['agency.example'],
      unknownStartDates: ['2000-01-01'],
      mode: 'apply',
    });
    expect(parseFusionArgs(by['fusion']!.argv)).toMatchObject({
      accountIds: [ACCT],
      unknownStartDates: ['2000-01-01'],
      apply: true,
    });
    expect(plan.agencyDomains).toEqual(['agency.example']);
  });

  it('PLAN: nothing is applied; load without a ledger dir is skipped with a reason', () => {
    const plan = buildPlan(castingArgs(), undefined);
    expect(plan.stages.every((s) => !s.apply)).toBe(true);
    const load = plan.stages.find((s) => s.stage === 'load')!;
    expect(load.skipReason).toMatch(/no --ledger-dir/);
    expect(plan.stages.find((s) => s.stage === 't1')!.argv).not.toContain('--apply');
  });

  it('PLAN with a ledger dir: load is a dry-run that needs a ledger at run time', () => {
    const load = buildPlan(castingArgs('--ledger-dir', LEDGER), undefined).stages.find(
      (s) => s.stage === 'load',
    )!;
    expect(load).toMatchObject({ skipReason: null, needsLedger: true, apply: false });
  });

  it('--apply does not apply t3; --apply-t3 does, with the caps and the ledger dir', () => {
    const free = buildPlan(castingArgs('--apply', '--ledger-dir', LEDGER), undefined);
    expect(free.stages.find((s) => s.stage === 't3')).toMatchObject({ apply: false });
    expect(free.stages.find((s) => s.stage === 't3')!.argv).not.toContain('--apply');
    const paid = buildPlan(castingArgs(...paidFlags(LEDGER)), undefined);
    const t3 = paid.stages.find((s) => s.stage === 't3')!;
    expect(t3.apply).toBe(true);
    expect(t3.pilotArgs).toMatchObject({
      mode: 'apply',
      ledgerDir: LEDGER,
      approval: { maxCells: 50, maxCostUsd: 5 },
    });
    // without --apply the free stages stay dry-runs
    expect(paid.stages.find((s) => s.stage === 't1')!.apply).toBe(false);
  });

  it('a bad T3 flag is found at build time, before any stage could run', () => {
    expect(() => buildPlan(castingArgs('--parallel', '9'), undefined)).toThrow(/parallel/);
    expect(() => buildPlan(castingArgs('--thinking', 'WILD'), undefined)).toThrow(/thinking/);
    expect(() => buildPlan(castingArgs('--known-prefix', 'x'), undefined)).toThrow(/known-prefix/);
    expect(() => buildPlan(castingArgs('--chunk-size', '0'), undefined)).toThrow(/chunk-size/);
    expect(() =>
      buildPlan(castingArgs('--agency-domain', 'not a domain', '--ledger-dir', LEDGER), undefined),
    ).toThrow(/agency-domain/);
  });

  it('--resume reaches only the named stage', () => {
    const plan = buildPlan(
      castingArgs('--apply', '--ledger-dir', LEDGER, '--resume', `t2=${RUN_ID}`),
      undefined,
    );
    expect(plan.stages.find((s) => s.stage === 't2')!.argv).toContain(RUN_ID);
    expect(plan.stages.find((s) => s.stage === 't1')!.argv).not.toContain('--resume-run-id');
  });

  it('--read-text reaches a PLAN pilot but not a paid one', () => {
    const plan = buildPlan(castingArgs('--read-text'), undefined);
    expect(plan.stages.find((s) => s.stage === 't3')!.argv).toContain('--read-text');
    const paid = buildPlan(castingArgs('--read-text', ...paidFlags(LEDGER)), undefined);
    expect(paid.stages.find((s) => s.stage === 't3')!.argv).not.toContain('--read-text');
  });
});

describe('mergeAgencyDomains', () => {
  it('env first, flags added, lower-cased, de-duplicated; unset env is fine', () => {
    expect(mergeAgencyDomains('A.example, b.example', ['B.example', 'c.example'])).toEqual([
      'a.example',
      'b.example',
      'c.example',
    ]);
    expect(mergeAgencyDomains(undefined, [])).toEqual([]);
  });
});
