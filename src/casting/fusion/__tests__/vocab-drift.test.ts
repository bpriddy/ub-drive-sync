import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/casting-vocab.snapshot.json';
import { BUDGET_BANDS, CASTING_MIN_CONFIDENCE, CASTING_MIN_TIERS, PROJECT_TYPES } from '../vocab';

// The literals in ../vocab mirror gub-schemas src/casting.ts (unpublished 1.23.0).
// This test fails when the module and the snapshot drift apart.
describe('casting fusion vocabulary mirror', () => {
  it('project types match the snapshot (14 values, `other` last)', () => {
    expect([...PROJECT_TYPES]).toEqual(snapshot.project_types);
    expect(PROJECT_TYPES).toHaveLength(14);
    expect(PROJECT_TYPES[PROJECT_TYPES.length - 1]).toBe('other');
  });

  it('budget bands match the snapshot, lowest to highest', () => {
    expect([...BUDGET_BANDS]).toEqual(snapshot.budget_bands);
  });

  it('serving thresholds match the snapshot', () => {
    expect(CASTING_MIN_CONFIDENCE).toBe(snapshot.min_confidence);
    expect(CASTING_MIN_TIERS).toBe(snapshot.min_tiers);
  });
});
