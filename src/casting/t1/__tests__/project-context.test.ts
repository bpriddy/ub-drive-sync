import { describe, expect, it } from 'vitest';
import { deriveProjectContext, normaliseSegment, splitPath } from '../project-context';

const ACME = new Set(['ACME']);
const ctx = (path: string, name: string, campaignId: string | null = null) =>
  deriveProjectContext({ path, name, campaignId }, { knownPrefixes: ACME });

describe('splitPath', () => {
  it('drops the file name, which ends the breadcrumb', () => {
    expect(splitPath('Root / A / B / f.pdf', 'f.pdf')).toEqual(['Root', 'A', 'B']);
    expect(splitPath('Root / A / B', 'f.pdf')).toEqual(['Root', 'A', 'B']);
    expect(splitPath(null, 'f.pdf')).toEqual([]);
  });
});

describe('normaliseSegment', () => {
  it('folds case, diacritics, ordinal prefixes and spaces', () => {
    expect(normaliseSegment('  02.  Café   Lumière ')).toBe('cafe lumiere');
    expect(normaliseSegment('Żółć Projekt')).toBe('zołc projekt');
  });
});

describe('deriveProjectContext', () => {
  it('uses a strict bracket code in a folder name, deepest folder context kept', () => {
    const c = ctx(
      'Root / Master / 2025 / 13. Acme | Spring [ACME55000216] / Strategy / deck.pptx',
      'deck.pptx',
    );
    expect(c).toMatchObject({
      projectKey: 'job:ACME55000216',
      strength: 'job_code',
      nameKey: null,
    });
    expect(c.contextSegments).toEqual([
      'Root',
      'Master',
      '2025',
      '13. Acme | Spring [ACME55000216]',
    ]);
  });

  it('does not read a code out of the file name', () => {
    const c = ctx('Root / Misc / [ACME55000216] notes.pdf', '[ACME55000216] notes.pdf');
    expect(c.jobCode).toBeNull();
  });

  it('marks variants and unbracketed codes weak, and prefers the strict form', () => {
    expect(ctx('Root / X [ACME55000216-01] / f.pdf', 'f.pdf')).toMatchObject({
      projectKey: 'job:ACME55000216',
      strength: 'job_code_weak',
    });
    expect(ctx('Root / ACME55000300 Final Files / f.pdf', 'f.pdf')).toMatchObject({
      projectKey: 'job:ACME55000300',
      strength: 'job_code_weak',
    });
    // A strict code higher up outranks an unbracketed one deeper down.
    expect(ctx('Root / A [ACME55000216] / ACME55000300 Final / f.pdf', 'f.pdf').projectKey).toBe(
      'job:ACME55000216',
    );
  });

  it('falls back to the campaign the index attributes the file to', () => {
    expect(ctx('Root / Brand X / f.pdf', 'f.pdf', 'camp-1')).toMatchObject({
      projectKey: 'campaign:camp-1',
      strength: 'campaign',
    });
  });

  it('a job code outranks the campaign attribution', () => {
    expect(ctx('Root / A [ACME55000216] / f.pdf', 'f.pdf', 'camp-1').strength).toBe('job_code');
  });

  it('name-keys the first non-container folder below the root, container years included', () => {
    const c = ctx('Root / Current Projects / 2019-2021 / Brand X / a.pdf', 'a.pdf');
    expect(c).toMatchObject({
      projectKey: 'name:current projects / 2019-2021 / brand x',
      strength: 'name_key',
      nameKey: 'current projects / 2019-2021 / brand x',
    });
    // The same name under another year folder is another project.
    expect(ctx('Root / Current Projects / 2022 / Brand X / a.pdf', 'a.pdf').projectKey).not.toBe(
      c.projectKey,
    );
  });

  it('says nothing about a project for a file at the root or under containers only', () => {
    expect(ctx('Root / loose.pdf', 'loose.pdf').strength).toBe('none');
    expect(ctx('Root / Archive / 2018 / loose.pdf', 'loose.pdf').strength).toBe('none');
    expect(
      deriveProjectContext({ path: null, name: 'x', campaignId: null }, { knownPrefixes: ACME })
        .strength,
    ).toBe('none');
  });
});
