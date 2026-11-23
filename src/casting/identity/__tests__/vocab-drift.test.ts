import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/casting-vocab.snapshot.json';
import {
  CASTING_EMPLOYMENT_START_TOLERANCE_DAYS,
  PERSON_KINDS,
  ROLE_NORMS,
  SENIORITIES,
  WITHHELD_REASONS,
} from '../vocab';

// The literals in ../vocab mirror gub-schemas src/casting.ts at source commit e305c25
// (unpublished 1.23.0). This test fails when the module and the snapshot drift apart.
// After 1.23.0 is pinned, import the sets from the package in ../vocab and keep this
// test: it then compares the package exports with the snapshot.
describe('casting vocabulary mirror (source commit e305c25)', () => {
  it('role_norm set and order match the snapshot', () => {
    expect([...ROLE_NORMS]).toEqual(snapshot.role_norms);
  });

  it('role_norm has 23 values and keeps `other` last', () => {
    expect(ROLE_NORMS).toHaveLength(23);
    expect(ROLE_NORMS[ROLE_NORMS.length - 1]).toBe('other');
    expect(new Set(ROLE_NORMS).size).toBe(ROLE_NORMS.length);
  });

  it('seniority set and order match the snapshot', () => {
    expect([...SENIORITIES]).toEqual(snapshot.seniorities);
  });

  it('person kinds and withheld reasons match the snapshot', () => {
    expect([...PERSON_KINDS]).toEqual(snapshot.person_kinds);
    expect([...WITHHELD_REASONS]).toEqual(snapshot.withheld_reasons);
  });

  it('employment start tolerance matches the snapshot', () => {
    expect(CASTING_EMPLOYMENT_START_TOLERANCE_DAYS).toBe(snapshot.employment_start_tolerance_days);
  });
});
