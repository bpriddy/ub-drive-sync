import { describe, expect, it } from 'vitest';
import type { TraversedFile } from '../../../drive/types';
import { ancestorsOf, jobNumberOf, toCandidate, toCandidates } from '../listing-candidates';

const file = (over: Partial<TraversedFile>): TraversedFile => ({
  id: 'f1',
  name: 'Team deck',
  mimeType: 'application/vnd.google-apps.presentation',
  path: 'root / 2024 / Spring [ACME12345678] / Team deck',
  modifiedTime: '2025-03-01T00:00:00.000Z',
  modifiedByEmail: null,
  createdTime: '2025-01-01T00:00:00.000Z',
  size: null,
  isFolder: false,
  ...over,
});

describe('listing -> candidate', () => {
  it('ancestors are the folders only: the trailing file name is dropped', () => {
    expect(ancestorsOf(file({}))).toEqual(['root', '2024', 'Spring [ACME12345678]']);
    expect(ancestorsOf(file({ path: 'root / Team deck', name: 'Other' }))).toEqual([
      'root',
      'Team deck',
    ]);
    expect(ancestorsOf(file({ path: 'Team deck', name: 'Team deck' }))).toEqual(['Team deck']);
  });

  it('the job number is the strict bracket code of the deepest folder that has one', () => {
    expect(jobNumberOf(['root', 'Old [ACME11111111]', 'New [ACME22222222]', 'Plain'])).toBe(
      'ACME22222222',
    );
    expect(jobNumberOf(['root', '2024', 'No code'])).toBeNull();
  });

  it('keeps md5 and times, carries the job number as the only project reference', () => {
    const c = toCandidate(file({ md5Checksum: 'abc' }), 'acct');
    expect(c).toMatchObject({
      fileId: 'f1',
      accountId: 'acct',
      md5Checksum: 'abc',
      modifiedTime: '2025-03-01T00:00:00.000Z',
      projectRef: { jobNumber: 'ACME12345678' },
    });
    const plain = toCandidate(file({ path: 'root / Team deck' }), 'acct');
    expect(plain.projectRef).toBeUndefined();
    expect(plain.md5Checksum).toBeNull();
  });

  it('drops folders, keeps shortcuts for the shortlist step to count', () => {
    const out = toCandidates(
      [
        file({ id: 'a' }),
        file({ id: 'b', isFolder: true }),
        file({ id: 'c', mimeType: 'application/vnd.google-apps.shortcut' }),
      ],
      'acct',
    );
    expect(out.map((c) => c.fileId)).toEqual(['a', 'c']);
  });
});
