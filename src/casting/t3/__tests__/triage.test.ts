import { describe, expect, it } from 'vitest';
import { selectCandidates, triage, versionFamilyKey, docClassOf } from '../triage';
import { ACCOUNT, GDOC, GSHEET, GSLIDES, PDF, cand } from './helpers';

const t = (name: string, folder: string, mime = GDOC) => {
  const docClass = docClassOf(mime);
  if (docClass === null) throw new Error('fixture mime');
  return triage({ name, parentFolder: folder, mimeType: mime, docClass });
};

describe('triage tiers', () => {
  it('a team keyword in the name is tier A', () => {
    expect(t('Spring Launch Team and Credits', 'Work')).toEqual({ tier: 'A', why: 'kw_name' });
    expect(t('Kick-off notes', 'Work').tier).toBe('A');
    expect(t('SOW v2', 'Work').tier).toBe('A');
  });

  it('a keyword in the parent folder is tier A, unless the file is a script', () => {
    expect(t('Doc 1', 'Pre-Production').tier).toBe('A');
    expect(t('Spot script', 'Pre-Production')).toEqual({ tier: 'C', why: 'scripts' });
  });

  it('every deck is at least tier B, a plain doc needs a moderate keyword', () => {
    expect(t('Untitled', 'Stuff', GSLIDES)).toEqual({ tier: 'B', why: 'deck' });
    expect(t('Weekly review', 'Stuff').tier).toBe('B');
    expect(t('Misc', 'Stuff')).toEqual({ tier: 'C', why: 'other' });
  });

  it('sheets and plain text are A with a keyword, never B', () => {
    expect(t('Staffing plan', 'Work', GSHEET).tier).toBe('A');
    expect(t('Weekly review', 'Work', GSHEET).tier).toBe('C');
  });

  it('hard noise is X: invoices, build output, sidecars, code mimes', () => {
    expect(t('Invoice 442', 'Finance').tier).toBe('X');
    expect(t('main.js', 'Work', 'text/plain').tier).toBe('X');
    expect(t('notes', 'Work', 'text/html').tier).toBe('X');
    expect(t('IMG_0001.xmp', 'Work', 'text/plain').tier).toBe('X');
  });

  it('signed agreements stay out of A and B', () => {
    expect(t('Signed Agreement', 'Legal', PDF)).toEqual({ tier: 'C', why: 'signed_agreements' });
  });
});

describe('docClassOf', () => {
  it('knows the extractor classes and rejects the rest', () => {
    expect(docClassOf(GDOC)).toBe('gdoc');
    expect(docClassOf('text/csv')).toBe('text');
    expect(docClassOf('application/vnd.ms-excel')).toBeNull();
    expect(docClassOf('application/vnd.google-apps.shortcut')).toBeNull();
  });
});

describe('versionFamilyKey', () => {
  it('collapses v2 / final / copy / dates within one folder only', () => {
    const a = cand({ fileId: 'a', name: 'Status Report v2 (final).docx', ancestors: ['P1'] });
    const b = cand({ fileId: 'b', name: 'status report 03-14.docx', ancestors: ['P1'] });
    const c = cand({ fileId: 'c', name: 'Status Report.docx', ancestors: ['P2'] });
    expect(versionFamilyKey(a)).toBe(versionFamilyKey(b));
    expect(versionFamilyKey(a)).not.toBe(versionFamilyKey(c));
  });
});

describe('selectCandidates', () => {
  const policy = { windowStart: '2021-11-19' };

  it('base keeps A+B, tight keeps A, recall_max keeps C too', () => {
    const files = [
      cand({ fileId: 'a', name: 'Team and credits' }),
      cand({ fileId: 'b', name: 'Weekly review', ancestors: ['X'] }),
      // c: a PDF with no keyword anywhere
      cand({ fileId: 'c', name: 'Random', ancestors: ['Y'], mimeType: PDF }),
    ];
    expect(selectCandidates(files, policy).selected.map((s) => s.candidate.fileId)).toEqual([
      'a',
      'b',
    ]);
    expect(
      selectCandidates(files, { ...policy, variant: 'tight' }).selected.map(
        (s) => s.candidate.fileId,
      ),
    ).toEqual(['a']);
    expect(
      selectCandidates(files, { ...policy, variant: 'recall_max' }).selected.map(
        (s) => s.candidate.fileId,
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('applies the window, the epoch rule, mime support and counts each exclusion', () => {
    const files = [
      cand({ fileId: 'old', name: 'Team', modifiedTime: '2019-01-01T00:00:00Z' }),
      cand({ fileId: 'epoch', name: 'Team', modifiedTime: '1980-01-01T00:00:00Z' }),
      cand({ fileId: 'none', name: 'Team', modifiedTime: null }),
      cand({ fileId: 'xls', name: 'Team', mimeType: 'application/vnd.ms-excel' }),
      cand({ fileId: 'inv', name: 'Invoice', ancestors: ['Finance'] }),
      cand({ fileId: 'ok', name: 'Team' }),
    ];
    const sel = selectCandidates(files, policy);
    expect(sel.selected.map((s) => s.candidate.fileId)).toEqual(['ok']);
    expect(sel.excluded).toMatchObject({
      outside_window: 1,
      epoch_date: 1,
      no_modified_time: 1,
      unsupported_mime: 1,
      hard_noise: 1,
    });
  });

  it('native-only accounts drop binaries by rule; canDownload=false drops binaries elsewhere', () => {
    const files = [
      cand({ fileId: 'n', name: 'Team', accountId: 'locked' }),
      cand({
        fileId: 'b',
        name: 'Team deck',
        mimeType: PDF,
        accountId: 'locked',
        ancestors: ['A'],
      }),
      cand({ fileId: 'd', name: 'Team deck', mimeType: PDF, canDownload: false, ancestors: ['B'] }),
      cand({ fileId: 'e', name: 'Team deck', mimeType: PDF, ancestors: ['C'] }),
    ];
    const sel = selectCandidates(files, { ...policy, nativeOnlyAccountIds: new Set(['locked']) });
    expect(sel.selected.map((s) => s.candidate.fileId)).toEqual(['e', 'n']);
    expect(sel.excluded.native_only_binary).toBe(1);
    expect(sel.excluded.cannot_download).toBe(1);
  });

  it('collapses same-md5 files and version families, keeping the newest, and reports the mapping', () => {
    const files = [
      cand({
        fileId: 'z1',
        name: 'Team.pdf',
        mimeType: PDF,
        md5Checksum: 'm1',
        ancestors: ['P1'],
        modifiedTime: '2024-01-01T00:00:00Z',
      }),
      cand({
        fileId: 'z2',
        name: 'Team copy.pdf',
        mimeType: PDF,
        md5Checksum: 'm1',
        ancestors: ['P2'],
        modifiedTime: '2024-06-01T00:00:00Z',
      }),
      cand({
        fileId: 'v1',
        name: 'Staffing v1',
        ancestors: ['P3'],
        modifiedTime: '2024-01-01T00:00:00Z',
      }),
      cand({
        fileId: 'v2',
        name: 'Staffing v2',
        ancestors: ['P3'],
        modifiedTime: '2024-02-01T00:00:00Z',
      }),
      cand({
        fileId: 'v3',
        name: 'Staffing FINAL',
        ancestors: ['P3'],
        modifiedTime: '2024-03-01T00:00:00Z',
      }),
    ];
    const sel = selectCandidates(files, policy);
    expect(sel.selected.map((s) => s.candidate.fileId).sort()).toEqual(['v3', 'z2']);
    expect(sel.excluded.duplicate_md5).toBe(1);
    expect(sel.excluded.duplicate_version_family).toBe(2);
    expect(sel.duplicateOf.get('z1')).toBe('z2');
    expect(sel.duplicateOf.get('v1')).toBe('v3');
    expect(sel.duplicateOf.get('v2')).toBe('v3');
  });

  it('orders A before B and is stable by file id', () => {
    const files = [
      cand({ fileId: 'b2', name: 'Weekly review', ancestors: ['X'] }),
      cand({ fileId: 'a2', name: 'Team', ancestors: ['Y'] }),
      cand({ fileId: 'a1', name: 'Credits', ancestors: ['Z'] }),
    ];
    expect(selectCandidates(files, policy).selected.map((s) => s.candidate.fileId)).toEqual([
      'a1',
      'a2',
      'b2',
    ]);
    expect(selectCandidates(files, policy).tierCounts).toEqual({ A: 2, B: 1, C: 0 });
    expect(ACCOUNT).toBe('acct-0001');
  });
});
