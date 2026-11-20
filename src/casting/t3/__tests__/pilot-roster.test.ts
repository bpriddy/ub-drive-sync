/**
 * The pilot's roster wiring: `--unknown-start-date` reaches the identity module the T2 way
 * (a placeholder start date is treated as an unknown start, so the window gate is off for it).
 * No database: `buildPilotRoster` is the pure part of `loadRosterIndex`.
 */
import { describe, expect, it } from 'vitest';
import { buildPilotRoster } from '../real-pilot-io';
import { resolveIdentity, type RosterEntry } from '../../identity';

const PLACEHOLDER = '2026-04-22';
const ENTRIES: RosterEntry[] = [
  {
    staffId: 'staff-01',
    fullName: 'Pat Example',
    email: 'pat@agency.example',
    startedAt: PLACEHOLDER,
    isActive: true,
    isPerson: true,
  },
];
const resolveEarly = (index: ReturnType<typeof buildPilotRoster>) =>
  resolveIdentity(index, {
    rawName: '',
    rawEmail: 'pat@agency.example',
    evidenceDate: '2020-01-01',
  }).personKind;

describe('buildPilotRoster', () => {
  it('without dates the placeholder start gates earlier evidence (no behaviour change)', () => {
    const index = buildPilotRoster(ENTRIES, ['agency.example'], { unknownStartDates: [] });
    expect(resolveEarly(index)).not.toBe('staff');
  });

  it('with the date listed the window gate is off for that row', () => {
    const index = buildPilotRoster(ENTRIES, ['agency.example'], {
      unknownStartDates: [PLACEHOLDER],
    });
    expect(resolveEarly(index)).toBe('staff');
  });
});
