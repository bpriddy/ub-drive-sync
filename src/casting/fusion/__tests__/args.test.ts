import { describe, expect, it } from 'vitest';
import { parseFusionArgs } from '../args';
import { ACCOUNT, OTHER_ACCOUNT } from './fixtures';

describe('parseFusionArgs', () => {
  it('defaults to a dry-run', () => {
    expect(parseFusionArgs(['--account-id', ACCOUNT])).toEqual({
      accountIds: [ACCOUNT],
      apply: false,
      chunkSize: null,
      unknownStartDates: [],
    });
  });

  it('--apply is the only way to write', () => {
    expect(parseFusionArgs(['--account-id', ACCOUNT, '--apply']).apply).toBe(true);
  });

  it('accepts repeated accounts, inline values and placeholder dates', () => {
    const a = parseFusionArgs([
      `--account-id=${ACCOUNT}`,
      '--account-id',
      OTHER_ACCOUNT,
      '--account-id',
      ACCOUNT,
      '--chunk-size=100',
      '--unknown-start-date',
      '2020-01-01',
    ]);
    expect(a.accountIds).toEqual([ACCOUNT, OTHER_ACCOUNT]);
    expect(a.chunkSize).toBe(100);
    expect(a.unknownStartDates).toEqual(['2020-01-01']);
  });

  it.each([
    [[], 'at least one --account-id'],
    [['--account-id', 'nope'], 'must be a uuid'],
    [['--account-id', ACCOUNT, '--bogus'], 'unknown argument'],
    [['--account-id', ACCOUNT, '--chunk-size'], 'needs a value'],
    [['--account-id', ACCOUNT, '--chunk-size', '0'], 'integer from 1 to 20000'],
    [['--account-id', ACCOUNT, '--unknown-start-date', '2020-13-45'], 'YYYY-MM-DD'],
    [['--account-id', ACCOUNT, '--apply=yes'], 'unknown argument'],
  ])('rejects %j', (args, message) => {
    expect(() => parseFusionArgs(args as string[])).toThrow(message);
  });
});
