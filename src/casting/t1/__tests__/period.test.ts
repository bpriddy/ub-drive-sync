import { describe, expect, it } from 'vitest';
import {
  DateHistogram,
  NO_PERIOD,
  applyWindow,
  campaignDatePeriod,
  folderYearPeriod,
  usableDate,
  yearsInSegment,
} from '../period';

const TODAY = new Date(Date.UTC(2026, 10, 19));
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('usableDate', () => {
  it('rejects missing, placeholder and future dates', () => {
    expect(usableDate(null, TODAY)).toBeNull();
    expect(usableDate(new Date('invalid'), TODAY)).toBeNull();
    expect(usableDate(d('1980-01-01'), TODAY)).toBeNull();
    expect(usableDate(d('1989-12-31'), TODAY)).toBeNull();
    expect(usableDate(d('2030-01-01'), TODAY)).toBeNull();
    expect(usableDate(d('2024-05-06'), TODAY)).not.toBeNull();
  });
});

describe('yearsInSegment', () => {
  it('reads plain years, ranges and fiscal-year shorthand', () => {
    expect(yearsInSegment('2025 BTS', TODAY)).toEqual([2025]);
    expect(yearsInSegment('2019-2021', TODAY)).toEqual([2019, 2021]);
    expect(yearsInSegment('FY24 Plan', TODAY)).toEqual([2024]);
  });

  it('does not read job-code digits or implausible years', () => {
    expect(yearsInSegment('[ACME55002025] Spring', TODAY)).toEqual([]);
    expect(yearsInSegment('ACME2025 Launch', TODAY)).toEqual([]);
    expect(yearsInSegment('Phone 1980 retro', TODAY)).toEqual([]);
    expect(yearsInSegment('2031 ideas', TODAY)).toEqual([]);
    expect(yearsInSegment('Item 12025', TODAY)).toEqual([]);
  });
});

describe('folderYearPeriod', () => {
  it('takes the deepest folder that has a year', () => {
    expect(folderYearPeriod(['Root', '2023', 'Proj [ACME55000216]'], TODAY)).toEqual({
      start: '2023-01-01',
      end: '2023-12-31',
      basis: 'folder_year',
    });
    expect(folderYearPeriod(['Root', '2023', '2025 BTS'], TODAY).start).toBe('2025-01-01');
  });

  it('spans a range and never ends in the future', () => {
    expect(folderYearPeriod(['Root', '2019-2021'], TODAY)).toMatchObject({
      start: '2019-01-01',
      end: '2021-12-31',
    });
    expect(folderYearPeriod(['Root', '2026'], TODAY)).toMatchObject({
      start: '2026-01-01',
      end: '2026-11-19',
    });
  });

  it('is unknown without any year', () => {
    expect(folderYearPeriod(['Root', 'Brand X'], TODAY)).toEqual(NO_PERIOD);
  });
});

describe('campaignDatePeriod', () => {
  it('needs a start, ignores an end that precedes it', () => {
    expect(campaignDatePeriod(undefined)).toEqual(NO_PERIOD);
    expect(
      campaignDatePeriod({ id: 'c', awardedAt: null, liveAt: null, endsAt: '2024-01-01' }),
    ).toEqual(NO_PERIOD);
    expect(
      campaignDatePeriod({
        id: 'c',
        awardedAt: '2024-02-01',
        liveAt: '2024-03-01',
        endsAt: '2024-09-30',
      }),
    ).toEqual({
      start: '2024-02-01',
      end: '2024-09-30',
      basis: 'campaign_dates',
    });
    expect(
      campaignDatePeriod({ id: 'c', awardedAt: null, liveAt: '2024-03-01', endsAt: '2024-01-01' })
        .end,
    ).toBeNull();
  });
});

describe('DateHistogram window', () => {
  it('needs enough dated files', () => {
    const h = new DateHistogram();
    for (let i = 0; i < 7; i++) h.add(d('2025-03-10'));
    expect(h.window()).toEqual(NO_PERIOD);
  });

  it('drops outliers at both ends (re-used old assets, a late touch)', () => {
    const h = new DateHistogram();
    h.add(d('2015-06-01'));
    for (let m = 3; m <= 6; m++) for (let i = 0; i < 5; i++) h.add(d(`2025-0${m}-15`));
    h.add(d('2026-10-01'));
    const w = h.window();
    expect(w.basis).toBe('file_dates');
    expect(w.start).toBe('2025-03-01');
    expect(w.end).toBe('2025-06-30');
  });
});

describe('applyWindow', () => {
  const p = { start: '2019-01-01', end: '2021-12-31', basis: 'folder_year' as const };
  it('drops a period wholly before the window, truncates one that straddles it', () => {
    expect(applyWindow(p, '2022-01-01')).toBeNull();
    expect(applyWindow(p, '2021-11-19')).toMatchObject({ start: '2021-11-19', end: '2021-12-31' });
    expect(applyWindow(p, '2018-01-01')).toEqual(p);
    expect(applyWindow(p, null)).toEqual(p);
  });
  it('lets an unknown period through', () => {
    expect(applyWindow(NO_PERIOD, '2021-11-19')).toEqual(NO_PERIOD);
  });
});
