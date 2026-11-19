import { describe, expect, it } from 'vitest';
import { parseT2Args } from '../args';
import { buildT2Roster } from '../roster';
import {
  buildRosterIndex,
  resolveIdentity,
  type RosterEntry,
  type RosterIndex,
  type RosterIndexOptions,
} from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('parseT2Args', () => {
  it('defaults to a dry-run and needs an explicit account', () => {
    const a = parseT2Args(['--account-id', UUID]);
    expect(a).toMatchObject({ apply: false, resumeRunId: null, windowStart: undefined });
    expect(() => parseT2Args([])).toThrow(/--account-id/);
  });
  it('parses every flag, repeatable ones included', () => {
    const a = parseT2Args([
      `--account-id=${UUID}`,
      '--apply',
      '--chunk-size',
      '500',
      '--window-start=none',
      '--budget-seconds',
      '60',
      '--agency-domain',
      'Agency.Example',
      '--unknown-start-date',
      '2000-01-01',
      '--unknown-start-date',
      '2000-01-01',
    ]);
    expect(a).toMatchObject({
      apply: true,
      chunkSize: 500,
      windowStart: null,
      budgetSeconds: 60,
      agencyDomains: ['agency.example'],
      unknownStartDates: ['2000-01-01'],
    });
  });
  it('is strict', () => {
    expect(() => parseT2Args(['--account-id', UUID, '--aply'])).toThrow(/unknown argument/);
    expect(() => parseT2Args(['--account-id'])).toThrow(/needs a value/);
    expect(() => parseT2Args(['--account-id', 'nope'])).toThrow(/uuid/);
    expect(() => parseT2Args(['--account-id', UUID, '--chunk-size', '0'])).toThrow(/chunk-size/);
    expect(() => parseT2Args(['--account-id', UUID, '--unknown-start-date', '2000-13-40'])).toThrow(
      /unknown-start-date/,
    );
    expect(() => parseT2Args(['--account-id', UUID, '--resume-run-id', UUID])).toThrow(/--apply/);
  });
});

describe('buildT2Roster', () => {
  const opts = { agencyDomains: ['agency.example'], unknownStartDates: [] as string[] };

  it('without unknown start dates it builds the plain index and runs no probe', () => {
    let calls = 0;
    const build = (e: readonly RosterEntry[], o?: RosterIndexOptions): RosterIndex => {
      calls += 1;
      return buildRosterIndex(e, o);
    };
    buildT2Roster(ROSTER, opts, build);
    expect(calls).toBe(1);
  });

  it('refuses to run when the identity module ignores unknownStartDates', () => {
    // The current build ignores the option: the probe row keeps its placeholder start and gates.
    const ignoring = (e: readonly RosterEntry[], o?: RosterIndexOptions): RosterIndex =>
      buildRosterIndex(e, { agencyEmailDomains: o?.agencyEmailDomains });
    expect(() =>
      buildT2Roster(ROSTER, { ...opts, unknownStartDates: ['2026-04-22'] }, ignoring),
    ).toThrow(/not supported/);
  });

  it('accepts a module that honours it (probe row passes the gate for an earlier date)', () => {
    // Stand-in for the S3 option: entries whose start is a listed placeholder get a very early start.
    const honouring = (e: readonly RosterEntry[], o?: RosterIndexOptions): RosterIndex => {
      const unknown = new Set(
        (o as { unknownStartDates?: readonly string[] } | undefined)?.unknownStartDates ?? [],
      );
      return buildRosterIndex(
        e.map((x) => (unknown.has(x.startedAt) ? { ...x, startedAt: '1900-01-01' } : x)),
        { agencyEmailDomains: o?.agencyEmailDomains },
      );
    };
    const idx = buildT2Roster(ROSTER, { ...opts, unknownStartDates: ['2026-04-22'] }, honouring);
    expect(
      resolveIdentity(idx, {
        rawName: '',
        rawEmail: 'user02@agency.example',
        evidenceDate: '2025-01-01',
      }).personKind,
    ).toBe('staff');
  });
});
