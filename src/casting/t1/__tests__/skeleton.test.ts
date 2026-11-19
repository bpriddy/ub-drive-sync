import { describe, expect, it } from 'vitest';
import { deriveProjectContext } from '../project-context';
import { SkeletonBuilder } from '../skeleton';
import { CAMPAIGN, CATALOG, PIECE, TODAY, WINDOW_START, file } from './fixtures';

const PREFIXES = new Set(['ACME']);
function build(
  files: ReturnType<typeof file>[],
  catalog = CATALOG,
  windowStart: string | null = WINDOW_START,
) {
  const b = new SkeletonBuilder({ today: TODAY, windowStart });
  for (const f of files) b.add(f, deriveProjectContext(f, { knownPrefixes: PREFIXES }));
  return b.build(catalog);
}

describe('SkeletonBuilder', () => {
  it('joins a coded project to its piece and campaign, and takes the period from the folder', () => {
    const sk = build([
      file({ path: 'R / 2024 / A [ACME55000216] / s / a.pdf', modifiedBy: 'u@x' }),
    ]);
    expect(sk.get('job:ACME55000216')).toMatchObject({
      pieceId: PIECE,
      campaignId: CAMPAIGN,
      jobNumber: 'ACME55000216',
      period: { start: '2024-01-01', end: '2024-12-31', basis: 'folder_year' },
      campaignConflict: false,
      fileCount: 1,
      modifierCount: 1,
    });
  });

  it('keeps the strongest code form for a code, whatever the file order', () => {
    const weak = file({ path: 'R / A [ACME55000300-01] / a.pdf' });
    const strict = file({ path: 'R / A [ACME55000300] / b.pdf' });
    expect(build([weak, strict]).get('job:ACME55000300')?.strength).toBe('job_code');
    expect(build([strict, weak]).get('job:ACME55000300')?.strength).toBe('job_code');
  });

  it('uses campaign dates, then the file-date window, only when folders carry no year', () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      file({
        path: 'R / Brand Z / x.pdf',
        campaignId: 'camp-z',
        modifiedTime: new Date(`2025-0${(i % 5) + 1}-10T00:00:00Z`),
      }),
    );
    const sk = build(files, { campaigns: [], pieces: [] });
    expect(sk.get('campaign:camp-z')?.period.basis).toBe('file_dates');
    const few = build(files.slice(0, 3), { campaigns: [], pieces: [] });
    expect(few.get('campaign:camp-z')?.period.basis).toBe('none');
  });

  it('never takes a period from createdTime or a placeholder date', () => {
    const files = Array.from({ length: 12 }, () =>
      file({
        path: 'R / Brand Z / x.pdf',
        campaignId: 'camp-z',
        modifiedTime: new Date('1980-01-01T00:00:00Z'),
      }),
    );
    const p = build(files, { campaigns: [], pieces: [] }).get('campaign:camp-z')!;
    expect(p.period.basis).toBe('none');
    expect(p.datedFileCount).toBe(0);
  });

  it('flags files of one project attributed to different campaigns', () => {
    const sk = build([
      file({ path: 'R / A [ACME55000300] / a.pdf', campaignId: 'c1' }),
      file({ path: 'R / A [ACME55000300] / b.pdf', campaignId: 'c2' }),
      file({ path: 'R / A [ACME55000300] / c.pdf', campaignId: 'c2' }),
    ]);
    const p = sk.get('job:ACME55000300')!;
    expect(p.campaignConflict).toBe(true);
    expect(p.campaignId).toBe('c2'); // majority attribution
  });

  it('marks a project wholly before the window out of scope and truncates a straddling one', () => {
    const old = build([file({ path: 'R / Archive / 2018 / Thing / a.pdf' })]).get(
      'name:archive / 2018 / thing',
    )!;
    expect(old.outOfWindow).toBe(true);
    const straddle = build([file({ path: 'R / 2021 / A [ACME55000301] / a.pdf' })]).get(
      'job:ACME55000301',
    )!;
    expect(straddle.outOfWindow).toBe(false);
    expect(straddle.period).toMatchObject({ start: WINDOW_START, end: '2021-12-31' });
  });

  describe('future-dated campaign falls through the ladder', () => {
    const FUTURE = {
      campaigns: [{ id: 'camp-f', awardedAt: '2027-03-01', liveAt: null, endsAt: '2027-09-30' }],
      pieces: [],
    };
    const dated = (n: number, path: string) =>
      Array.from({ length: n }, (_, i) =>
        file({
          path,
          campaignId: 'camp-f',
          modifiedTime: new Date(`2025-0${(i % 4) + 1}-10T00:00:00Z`),
        }),
      );

    it('goes to the file-date window when there are enough dated files', () => {
      const p = build(dated(10, 'R / Brand F / x.pdf'), FUTURE).get('campaign:camp-f')!;
      expect(p.period.basis).toBe('file_dates');
      expect(p.period.start! < '2027-01-01').toBe(true);
    });

    it('ends in no period when there is nothing else', () => {
      const p = build(dated(3, 'R / Brand F / x.pdf'), FUTURE).get('campaign:camp-f')!;
      expect(p.period).toMatchObject({ start: null, end: null, basis: 'none' });
    });

    it('a coded project in that campaign takes folder years before anything else', () => {
      const files = dated(10, 'R / 2025 / A [ACME55000400] / x.pdf');
      const p = build(files, FUTURE).get('job:ACME55000400')!;
      expect(p.period).toMatchObject({ start: '2025-01-01', basis: 'folder_year' });
    });

    it('a campaign with a past period still wins over the file window', () => {
      const past = {
        campaigns: [{ id: 'camp-f', awardedAt: '2024-02-01', liveAt: null, endsAt: '2024-09-30' }],
        pieces: [],
      };
      const p = build(dated(10, 'R / Brand F / x.pdf'), past).get('campaign:camp-f')!;
      expect(p.period).toMatchObject({
        start: '2024-02-01',
        end: '2024-09-30',
        basis: 'campaign_dates',
      });
    });
  });
});
