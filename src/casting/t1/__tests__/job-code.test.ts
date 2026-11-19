import { describe, expect, it } from 'vitest';
import { extractJobNumber } from '../../../drive/job-number';
import { recogniseJobCode, strictCodePrefix } from '../job-code';

const NONE = new Set<string>();
const ACME = new Set(['ACME']);

describe('recogniseJobCode', () => {
  it('agrees with extractJobNumber on the strict bracket form', () => {
    for (const name of [
      '13. Acme | Spring [ACME550002340]',
      '[ACME55000216] Kickoff',
      'x [QQ1234] y',
    ]) {
      expect(recogniseJobCode(name, NONE)).toMatchObject({
        code: extractJobNumber(name),
        form: 'bracket',
      });
    }
  });

  it('reads a bracket with a short suffix as the base code, marked as a variant', () => {
    expect(recogniseJobCode('02. Acme | Spring [ACME55000216-01]', NONE)).toEqual({
      code: 'ACME55000216',
      prefix: 'ACME',
      form: 'bracket_variant',
    });
    // The strict extractor does not see it: the new function must not change that one.
    expect(extractJobNumber('02. Acme | Spring [ACME55000216-01]')).toBeNull();
  });

  it('accepts an unbracketed code only with a known prefix', () => {
    expect(recogniseJobCode('ACME55000039 Final Files', NONE)).toBeNull();
    expect(recogniseJobCode('ACME55000039 Final Files', ACME)).toEqual({
      code: 'ACME55000039',
      prefix: 'ACME',
      form: 'unbracketed',
    });
    expect(recogniseJobCode('ZEBRA55000039 Final Files', ACME)).toBeNull();
  });

  it('does not take a code glued to other letters or digits', () => {
    expect(recogniseJobCode('XACME55000039', ACME)).toBeNull();
    expect(recogniseJobCode('ACME55000039x', ACME)).toBeNull();
    expect(recogniseJobCode('INV-2025-0041', ACME)).toBeNull();
    expect(recogniseJobCode('Q3 2025 plan', ACME)).toBeNull();
  });

  it('strictCodePrefix feeds the prefix census from strict codes only', () => {
    expect(strictCodePrefix('Spring [ACME55000216]')).toBe('ACME');
    expect(strictCodePrefix('Spring [ACME55000216-01]')).toBeNull();
    expect(strictCodePrefix('ACME55000216 bare')).toBeNull();
  });
});
