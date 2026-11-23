import { describe, expect, it } from 'vitest';
import { clampToRunDate, parsePeriod, parsePeriodText, runDay } from '../period';

const NOW = new Date('2026-11-19T10:00:00Z');
const TODAY = '2026-11-19';
const none = { start: null, end: null };
const p = (s: string | null, now: Date = NOW) => parsePeriod(s, now);

describe('run-date policy: a period starting after the run date is unknown', () => {
  it('a future year, quarter or month', () => {
    expect(p('2027')).toEqual(none);
    expect(p('Q3 2027')).toEqual(none);
    expect(p('Jan 2027')).toEqual(none);
    expect(p('2027-03')).toEqual(none);
    expect(p('2027-03-01')).toEqual(none);
    expect(p('Dec 2026')).toEqual(none);
  });

  it('a fiscal-year form is not read at all, as before', () => {
    expect(p('FY27')).toEqual(none);
    expect(p('FY2027')).toEqual(none);
    expect(p('FY26')).toEqual(none);
  });

  it('a range that starts in the future', () => {
    expect(p('2027-2028')).toEqual(none);
    expect(p('Jan 2027 to Mar 2027')).toEqual(none);
  });

  it('the day after the run date is unknown, the run date itself is not', () => {
    expect(p('2026-11-20')).toEqual(none);
    expect(p('2026-11-19')).toEqual({ start: TODAY, end: TODAY });
  });
});

describe('run-date policy: a period ending after the run date is clamped', () => {
  it('ranges that span the present', () => {
    expect(p('May 2026 - Mar 2027')).toEqual({ start: '2026-05-01', end: TODAY });
    expect(p('2025-2028')).toEqual({ start: '2025-01-01', end: TODAY });
    expect(p('Q4 2026')).toEqual({ start: '2026-10-01', end: TODAY });
  });

  it('the current year and month end at the run date', () => {
    expect(p('2026')).toEqual({ start: '2026-01-01', end: TODAY });
    expect(p('Nov 2026')).toEqual({ start: '2026-11-01', end: TODAY });
  });

  it('a range starting exactly on the run date collapses to that day', () => {
    expect(p('2026-11-19 to 2027-06')).toEqual({ start: TODAY, end: TODAY });
  });
});

describe('periods in the past are unchanged', () => {
  it('years, quarters, months and ranges', () => {
    expect(p('2023')).toEqual({ start: '2023-01-01', end: '2023-12-31' });
    expect(p('Q3 2023')).toEqual({ start: '2023-07-01', end: '2023-09-30' });
    expect(p('Feb 2024')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(p('2023-2024')).toEqual({ start: '2023-01-01', end: '2024-12-31' });
    expect(p('May 2023 - Aug 2023')).toEqual({ start: '2023-05-01', end: '2023-08-31' });
    expect(p('2025')).toEqual({ start: '2025-01-01', end: '2025-12-31' });
  });
});

describe('text that is partial or ambiguous is still unknown', () => {
  it('as before', () => {
    for (const s of [
      'sometime last spring',
      '12/31',
      '1885',
      '2099',
      'Aug 2023 - May 2023',
      '2023-13',
      '',
      null,
    ]) {
      expect(p(s)).toEqual(none);
    }
  });

  it('a range whose end is an implausible misread stays unknown', () => {
    expect(p('2023-2099')).toEqual(none);
  });
});

describe('clampToRunDate', () => {
  it('applies the two rules in order', () => {
    expect(clampToRunDate({ start: '2027-01-01', end: '2027-12-31' }, TODAY)).toEqual(none);
    expect(clampToRunDate({ start: '2026-01-01', end: '2027-12-31' }, TODAY)).toEqual({
      start: '2026-01-01',
      end: TODAY,
    });
    expect(clampToRunDate({ start: '2020-01-01', end: '2020-12-31' }, TODAY)).toEqual({
      start: '2020-01-01',
      end: '2020-12-31',
    });
  });

  it('is unknown when the clamped end would precede the start (defensive: a malformed period)', () => {
    expect(clampToRunDate({ start: '2026-12-01', end: '2026-01-01' }, TODAY)).toEqual(none);
    expect(clampToRunDate({ start: '2026-06-01', end: '2026-01-01' }, TODAY)).toEqual(none);
  });

  it('a half-known period is unknown', () => {
    expect(clampToRunDate({ start: '2020-01-01', end: null }, TODAY)).toEqual(none);
    expect(clampToRunDate({ start: null, end: '2020-01-01' }, TODAY)).toEqual(none);
  });
});

describe('the clock is injected', () => {
  it('the same text gives a different clamp on a different run date', () => {
    const later = new Date('2027-02-10T00:00:00Z');
    expect(p('2025-2028', later)).toEqual({ start: '2025-01-01', end: '2027-02-10' });
    expect(p('2027', later)).toEqual({ start: '2027-01-01', end: '2027-02-10' });
    expect(p('2027')).toEqual(none);
  });

  it('the run day is the UTC calendar day of the injected value', () => {
    expect(runDay(new Date('2026-11-19T23:30:00-05:00'))).toBe('2026-11-20');
  });

  it('parsePeriodText ignores the run date (it is the claim identity)', () => {
    expect(parsePeriodText('2027', NOW)).toEqual({ start: '2027-01-01', end: '2027-12-31' });
    expect(parsePeriodText('2025-2028', NOW)).toEqual({ start: '2025-01-01', end: '2028-12-31' });
  });
});
