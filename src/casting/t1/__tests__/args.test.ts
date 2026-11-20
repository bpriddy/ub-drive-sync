import { describe, expect, it } from 'vitest';
import { defaultWindowStart, parseT1Args } from '../args';

const ID = '11111111-1111-4111-8111-111111111111';

describe('parseT1Args', () => {
  it('defaults to a dry-run', () => {
    expect(parseT1Args(['--account-id', ID])).toMatchObject({
      accountIds: [ID],
      apply: false,
      resumeRunId: null,
      windowStart: undefined,
    });
  });

  it('reads every flag, with = or a separate value', () => {
    const a = parseT1Args([
      `--account-id=${ID}`,
      '--apply',
      '--chunk-size',
      '500',
      '--window-start=2021-11-19',
      '--budget-seconds',
      '240',
      '--agency-domain',
      'Agency.Example',
      '--known-prefix=ACME',
      `--resume-run-id=${ID}`,
    ]);
    expect(a).toMatchObject({
      apply: true,
      chunkSize: 500,
      windowStart: '2021-11-19',
      budgetSeconds: 240,
      agencyDomains: ['agency.example'],
      knownPrefixes: ['ACME'],
      resumeRunId: ID,
    });
    expect(parseT1Args(['--account-id', ID, '--window-start', 'none']).windowStart).toBeNull();
  });

  it('rejects a typo, a missing value and an unscoped run', () => {
    expect(() => parseT1Args(['--account-id', ID, '--confirm'])).toThrow(/unknown argument/);
    expect(() => parseT1Args(['--account-id', '--apply'])).toThrow(/needs a value/);
    expect(() => parseT1Args(['--account-id', 'nope'])).toThrow(/uuid/);
    expect(() => parseT1Args([])).toThrow(/at least one --account-id/);
    expect(() => parseT1Args(['--account-id', ID, '--chunk-size', '0'])).toThrow(/chunk-size/);
    expect(() => parseT1Args(['--account-id', ID, '--window-start', '2021-13-45'])).toThrow(
      /window-start/,
    );
    expect(() => parseT1Args(['--account-id', ID, '--resume-run-id', ID])).toThrow(/needs --apply/);
  });
});

describe('defaultWindowStart', () => {
  it('is five years before today', () => {
    expect(defaultWindowStart(new Date(Date.UTC(2026, 10, 19)))).toBe('2021-11-19');
  });
});
