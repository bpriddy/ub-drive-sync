import { describe, expect, it } from 'vitest';
import {
  T1_BASE_CONFIDENCE,
  assertEvidenceInvariants,
  candidateSkip,
  claimHash,
  confidenceOf,
  emitPresenceRow,
} from '../emit';
import { createPresenceResolver } from '../presence-resolver';
import type { ProjectSkeleton } from '../skeleton';
import { ACCOUNT, file, roster } from './fixtures';

const project = (over: Partial<ProjectSkeleton> = {}): ProjectSkeleton => ({
  key: 'job:ACME55000216',
  strength: 'job_code',
  jobNumber: 'ACME55000216',
  campaignId: null,
  pieceId: null,
  period: { start: '2025-01-01', end: '2025-12-31', basis: 'folder_year' },
  outOfWindow: false,
  fileCount: 3,
  datedFileCount: 3,
  modifierCount: 1,
  campaignConflict: false,
  ...over,
});

const resolve = createPresenceResolver(roster());
const run = (f: ReturnType<typeof file>, p = project(), nameKey: string | null = null) =>
  emitPresenceRow(f, { accountId: ACCOUNT, syncRunId: 'run-x', project: p, nameKey, resolve });

describe('emitPresenceRow', () => {
  it('writes a drive_metadata presence row with no role and no quote', () => {
    const r = run(file({ path: 'R / a.pdf', modifiedBy: ' User02@Agency.Example ' }));
    expect(r.row).toMatchObject({
      staffId: 'staff-02',
      rawName: 'user02@agency.example',
      personKind: 'staff',
      withheldReason: null,
      source: 'drive_metadata',
      roleRaw: null,
      roleNorm: null,
      seniority: null,
      quote: null,
      location: null,
      jobNumber: 'ACME55000216',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      extractorVersion: 't1-metadata-v1',
      syncRunId: 'run-x',
    });
  });

  it('does not evaluate the window gate: an old file touched by a later joiner still resolves', () => {
    // staff-07 started 2021-01-11; the file is dated 2015. Window gate must not fire.
    const r = run(
      file({
        path: 'R / a.pdf',
        modifiedBy: 'user07@agency.example',
        modifiedTime: new Date('2015-01-01T00:00:00Z'),
      }),
    );
    expect(r.row?.personKind).toBe('staff');
  });

  it('keeps non-staff modifiers as withheld rows, never as staff', () => {
    for (const email of ['someone@client.example', 'ghost@agency.example']) {
      const r = run(file({ path: 'R / a.pdf', modifiedBy: email }));
      expect(r.row).toMatchObject({
        staffId: null,
        personKind: 'external_unresolved',
        withheldReason: 'unresolved',
      });
    }
  });

  it('puts the name key of a name-keyed project into location, bounded', () => {
    const r = run(
      file({ path: 'R / a.pdf', modifiedBy: 'user02@agency.example' }),
      project({ strength: 'name_key', key: 'name:x', jobNumber: null }),
      'k'.repeat(500),
    );
    expect(r.row?.location?.startsWith('name:')).toBe(true);
    expect(r.row?.location?.length).toBeLessThanOrEqual(200);
  });

  it('skips what is not a candidate, and out-of-window projects', () => {
    expect(run(file({ path: 'R / a.pdf', modifiedBy: null })).skipped).toBe('no_modifier');
    expect(run(file({ path: 'R / a.pdf', modifiedBy: '  ' })).skipped).toBe('no_modifier');
    expect(
      run(
        file({
          path: 'R / a',
          mimeType: 'application/vnd.google-apps.shortcut',
          modifiedBy: 'user02@agency.example',
        }),
      ).skipped,
    ).toBe('not_content');
    expect(
      run(
        file({ path: 'R / a.pdf', modifiedBy: 'user02@agency.example' }),
        project({ outOfWindow: true }),
      ).skipped,
    ).toBe('out_of_window');
    expect(candidateSkip(file({ path: 'R / a.pdf', modifiedBy: 'u@x.example' }))).toBeNull();
  });
});

describe('confidence', () => {
  it('orders strict code > campaign > weak code > name key, and discounts weak period bases', () => {
    const c = (
      strength: ProjectSkeleton['strength'],
      basis: ProjectSkeleton['period']['basis'] = 'folder_year',
    ) => confidenceOf(project({ strength, period: { start: null, end: null, basis } }));
    expect(c('job_code')).toBeGreaterThan(c('campaign'));
    expect(c('campaign')).toBeGreaterThan(c('job_code_weak'));
    expect(c('job_code_weak')).toBeGreaterThan(c('name_key'));
    expect(c('job_code', 'file_dates')).toBeLessThan(c('job_code'));
    expect(c('job_code', 'none')).toBeLessThan(c('job_code', 'file_dates'));
  });

  it('stays weak by design: no single T1 row can reach the serving threshold', () => {
    expect(Math.max(...Object.values(T1_BASE_CONFIDENCE))).toBeLessThan(0.7);
  });
});

describe('claimHash', () => {
  const base = {
    source: 'drive_metadata',
    fileId: 'f1',
    location: null,
    rawName: 'a@x',
    roleRaw: null,
    projectKey: 'job:A1',
  };
  it('is stable and sensitive to the claim, not to the period', () => {
    expect(claimHash(base)).toBe(claimHash({ ...base }));
    expect(claimHash(base)).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { fileId: 'f2' },
      { rawName: 'b@x' },
      { projectKey: 'job:A2' },
      { location: 'name:k' },
    ]) {
      expect(claimHash({ ...base, ...change })).not.toBe(claimHash(base));
    }
    // Same claim, project period moved: same hash, so a re-run adds nothing.
    const a = run(file({ fileId: 'fx', path: 'R / a.pdf', modifiedBy: 'user02@agency.example' }));
    const b = run(
      file({ fileId: 'fx', path: 'R / a.pdf', modifiedBy: 'user02@agency.example' }),
      project({ period: { start: '2025-03-01', end: '2026-01-31', basis: 'file_dates' } }),
    );
    expect(a.row?.claimHash).toBe(b.row?.claimHash);
  });
});

describe('assertEvidenceInvariants (mirror of the table CHECKs)', () => {
  const ok = run(file({ path: 'R / a.pdf', modifiedBy: 'user02@agency.example' })).row!;
  it('accepts a good row and rejects each violation', () => {
    expect(() => assertEvidenceInvariants(ok)).not.toThrow();
    expect(() => assertEvidenceInvariants({ ...ok, confidence: 1.2 })).toThrow(/confidence/);
    expect(() =>
      assertEvidenceInvariants({ ...ok, periodStart: '2025-05-01', periodEnd: '2025-01-01' }),
    ).toThrow(/period/);
    expect(() => assertEvidenceInvariants({ ...ok, staffId: null })).toThrow(/staff_id/);
    expect(() =>
      assertEvidenceInvariants({
        ...ok,
        personKind: 'quarantined',
        staffId: null,
        withheldReason: null,
      }),
    ).toThrow(/withheld_reason/);
    expect(() => assertEvidenceInvariants({ ...ok, quote: 'x'.repeat(301) })).toThrow(/quote/);
  });
});
