import { describe, expect, it } from 'vitest';
import { scoreClaim, t3RowStrength, type ScoreRow } from '../score';
import {
  BREADTH_MAX_EXTRA,
  BREADTH_STEP,
  T3_BASE,
  T3_QUOTE_STEP,
  T3_ROLE_STEP,
  LOST_PITCH_FACTOR,
  SERVE_MIN_CONFIDENCE,
  TIER_CEILING,
  UNCORROBORATED_CEILING,
} from '../constants';
import { mulberry32, shuffle } from './fixtures';

// Content rows carry a grounded quote and a stated role unless a test says otherwise.
const t = (tier: ScoreRow['tier'], confidence: number, fileId: string): ScoreRow => ({
  tier,
  confidence,
  fileId,
  hasQuote: true,
  hasRole: true,
});

describe('scoreClaim: the documented formula', () => {
  it('a content mention alone stays under the serving threshold, however strong', () => {
    const r = scoreClaim([t('T3', 0.99, 'a')], 1);
    expect(r.tiers).toEqual(['T3']);
    expect(r.capped).toBe(true);
    expect(r.confidence).toBe(UNCORROBORATED_CEILING);
    expect(r.confidence).toBeLessThan(SERVE_MIN_CONFIDENCE);
  });

  it('agreement across tiers raises the score (noisy-or)', () => {
    // T3 row: min(0.95, 0.6 + 0.1 + 0.1) = 0.8; 1 - (1 - 0.8) * (1 - 0.3) = 0.86
    const r = scoreClaim([t('T3', 0.95, 'a'), t('T1', 0.3, 'b')], 1);
    expect(r.tierScores).toEqual({ T1: 0.3, T3: 0.8 });
    expect(r.confidence).toBe(0.86);
    expect(r.capped).toBe(false);
  });

  it('a weak name match needs more corroboration to reach the threshold', () => {
    const weakPlusT1 = scoreClaim([t('T3', 0.6, 'a'), t('T1', 0.15, 'b')], 1);
    expect(weakPlusT1.confidence).toBeLessThan(SERVE_MIN_CONFIDENCE); // 0.66
    const weakPlusBoth = scoreClaim([t('T3', 0.6, 'a'), t('T1', 0.15, 'b'), t('T2', 0.18, 'c')], 1);
    expect(weakPlusBoth.confidence).toBeGreaterThanOrEqual(SERVE_MIN_CONFIDENCE); // 0.72
  });

  it('T1 + T2 without a content row is capped below the threshold', () => {
    const r = scoreClaim([t('T1', 0.3, 'a'), t('T2', 0.18, 'b')], 1);
    expect(r.tiers).toEqual(['T1', 'T2']);
    expect(r.capped).toBe(true);
    expect(r.confidence).toBeLessThan(SERVE_MIN_CONFIDENCE);
  });

  it('files beyond the first inside one tier add a small, capped bonus', () => {
    const one = scoreClaim([t('T3', 0.7, 'a'), t('T1', 0.3, 'x')], 1);
    const three = scoreClaim(
      [t('T3', 0.7, 'a'), t('T3', 0.7, 'b'), t('T3', 0.7, 'c'), t('T1', 0.3, 'x')],
      1,
    );
    expect(three.tierScores.T3).toBeCloseTo(0.7 + 2 * BREADTH_STEP, 6);
    expect(three.confidence).toBeGreaterThan(one.confidence);
    const many = scoreClaim(
      [...Array(20).keys()].map((i) => t('T3', 0.7, `f${i}`)).concat(t('T1', 0.3, 'x')),
      1,
    );
    expect(many.tierScores.T3).toBeCloseTo(0.7 + BREADTH_MAX_EXTRA * BREADTH_STEP, 6);
  });

  it('copies of one file are one witness', () => {
    const r = scoreClaim([t('T3', 0.8, 'same'), t('T3', 0.8, 'same'), t('T1', 0.3, 'x')], 1);
    expect(r.tierScores.T3).toBe(0.8);
  });

  it('a second tier outweighs any amount of repetition inside one tier', () => {
    const repeated = scoreClaim(
      [...Array(50).keys()].map((i) => t('T3', 0.7, `f${i}`)),
      1,
    );
    const corroborated = scoreClaim([t('T3', 0.7, 'a'), t('T1', 0.3, 'b')], 1);
    expect(repeated.confidence).toBeLessThan(SERVE_MIN_CONFIDENCE);
    expect(corroborated.confidence).toBeGreaterThanOrEqual(SERVE_MIN_CONFIDENCE);
  });

  it('tier ceilings bind', () => {
    const r = scoreClaim(
      [...Array(9).keys()].map((i) => t('T1', 1, `f${i}`)),
      1,
    );
    expect(r.tierScores.T1).toBe(TIER_CEILING.T1);
  });

  it('a lost pitch scales every row by LOST_PITCH_FACTOR', () => {
    const normal = scoreClaim([t('T3', 0.9, 'a'), t('T1', 0.3, 'b')], 1);
    const lost = scoreClaim([t('T3', 0.9, 'a'), t('T1', 0.3, 'b')], LOST_PITCH_FACTOR);
    // The content row is first capped at 0.8 (quote and role), then scaled.
    expect(lost.tierScores.T3).toBeCloseTo(0.8 * LOST_PITCH_FACTOR, 3);
    expect(lost.confidence).toBeLessThan(normal.confidence);
  });

  it('a content row is worth what the mention shows: base, plus a grounded quote, plus a stated role', () => {
    const row = (q: boolean, role: boolean): ScoreRow => ({
      tier: 'T3',
      confidence: 0.95,
      fileId: 'a',
      hasQuote: q,
      hasRole: role,
    });
    expect(scoreClaim([row(false, false)], 1).tierScores.T3).toBe(T3_BASE);
    expect(scoreClaim([row(true, false)], 1).tierScores.T3).toBeCloseTo(T3_BASE + T3_QUOTE_STEP, 6);
    expect(scoreClaim([row(false, true)], 1).tierScores.T3).toBeCloseTo(T3_BASE + T3_ROLE_STEP, 6);
    expect(t3RowStrength(0.65, true, true)).toBe(0.65); // a weak name match still caps it
  });

  it('served claims spread out: quote, role, tiers and files each move the score', () => {
    const bare = scoreClaim(
      [
        { tier: 'T3', confidence: 0.95, fileId: 'a', hasQuote: false, hasRole: true },
        t('T1', 0.3, 'b'),
      ],
      1,
    );
    const quoted = scoreClaim([t('T3', 0.95, 'a'), t('T1', 0.3, 'b')], 1);
    const threeTiers = scoreClaim([t('T3', 0.95, 'a'), t('T1', 0.3, 'b'), t('T2', 0.18, 'c')], 1);
    expect(bare.confidence).toBeLessThan(quoted.confidence);
    expect(quoted.confidence).toBeLessThan(threeTiers.confidence);
    expect(threeTiers.confidence).toBeLessThan(1);
  });

  it('zero-confidence rows are not evidence of a tier', () => {
    const r = scoreClaim([t('T3', 0.9, 'a'), t('T1', 0, 'b')], 1);
    expect(r.tiers).toEqual(['T3']);
  });

  it('out-of-range and non-finite inputs cannot leave 0..1', () => {
    const r = scoreClaim([t('T3', 7, 'a'), t('T1', Number.NaN, 'b'), t('T2', -3, 'c')], 1);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.tiers).toEqual(['T3']);
  });

  it('no rows: zero', () => {
    expect(scoreClaim([], 1)).toEqual({ confidence: 0, tiers: [], tierScores: {}, capped: true });
  });
});

describe('scoreClaim: properties', () => {
  const rowsFor = (seed: number): ScoreRow[] => {
    const rnd = mulberry32(seed);
    const n = 1 + Math.floor(rnd() * 12);
    return [...Array(n).keys()].map((i) =>
      t(
        (['T1', 'T2', 'T3'] as const)[Math.floor(rnd() * 3)] as ScoreRow['tier'],
        rnd(),
        `f${Math.floor(rnd() * 6)}-${i % 3}`,
      ),
    );
  };

  it('is independent of row order', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rows = rowsFor(seed);
      expect(scoreClaim(shuffle(rows, seed + 1000), 1)).toEqual(scoreClaim(rows, 1));
    }
  });

  it('stays within 0..1, and a capped claim never reaches the serving threshold', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = scoreClaim(rowsFor(seed), seed % 2 === 0 ? 1 : LOST_PITCH_FACTOR);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      if (r.capped) expect(r.confidence).toBeLessThan(SERVE_MIN_CONFIDENCE);
    }
  });

  it('adding a row never lowers the score', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rows = rowsFor(seed);
      const extra = t('T3', 0.9, 'extra-file');
      expect(scoreClaim([...rows, extra], 1).confidence).toBeGreaterThanOrEqual(
        scoreClaim(rows, 1).confidence,
      );
    }
  });
});
