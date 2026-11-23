import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/casting-vocab.snapshot.json';
import { CASTING_MIN_CONFIDENCE, CASTING_MIN_TIERS } from '../vocab';

// The thresholds come from '@anomaly-technology/gub-schemas' (since 1.26.0), re-exported
// by ../vocab. This test compares them with a committed snapshot, so a package bump that
// changes one fails loudly instead of silently.
describe('casting fusion thresholds (gub-schemas package vs snapshot)', () => {
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
