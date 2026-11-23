import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/casting-vocab.snapshot.json';
import { EVIDENCE_QUOTE_MAX_CHARS, EVIDENCE_SOURCES } from '../../t1/types';
import {
  CASTING_EMPLOYMENT_START_TOLERANCE_DAYS,
  PERSON_KINDS,
  ROLE_NORMS,
  SENIORITIES,
  WITHHELD_REASONS,
} from '../vocab';

// The sets come from '@anomaly-technology/gub-schemas' (since 1.26.0), re-exported by
// ../vocab. This test compares them with a committed snapshot, so a package bump that
// changes a set the identity stage depends on fails loudly instead of silently.
describe('casting vocabulary (gub-schemas package vs snapshot)', () => {
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

  it('evidence sources and quote limit match the snapshot', () => {
    expect([...EVIDENCE_SOURCES]).toEqual(snapshot.evidence_sources);
    expect(EVIDENCE_QUOTE_MAX_CHARS).toBe(snapshot.evidence_quote_max_chars);
  });
});
