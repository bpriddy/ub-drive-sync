import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/casting-vocab.snapshot.json';
import { CASTING_MIN_CONFIDENCE, CASTING_MIN_TIERS } from '../vocab';

// The literals in ../vocab mirror gub-schemas src/casting.ts (unpublished 1.23.0,
// source commit e305c25). This test fails when the module and the snapshot drift apart.
describe('casting fusion vocabulary mirror', () => {
  it('serving thresholds match the snapshot', () => {
    expect(CASTING_MIN_CONFIDENCE).toBe(snapshot.min_confidence);
    expect(CASTING_MIN_TIERS).toBe(snapshot.min_tiers);
  });

  it('the snapshot carries no vocabulary of the removed experience traits', () => {
    expect(Object.keys(snapshot).sort()).toEqual(
      ['$comment', 'min_confidence', 'min_tiers'].sort(),
    );
  });
});
