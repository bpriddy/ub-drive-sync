/**
 * The confidence formula (fusion-v2). Pure arithmetic over a claim's evidence.
 *
 * For one claim (person x project x role), over its usable evidence rows:
 *
 *   row strength    s_i  = clamp01(confidence_i) * pitchFactor; for a T3 row the
 *                          confidence is first capped at
 *                          T3_BASE + T3_QUOTE_STEP*[quote] + T3_ROLE_STEP*[role]
 *                          pitchFactor = LOST_PITCH_FACTOR when the project's
 *                          campaign status says the pitch was lost, else 1
 *   tier score      S_t  = min(TIER_CEILING[t],
 *                              max(s_i in t) + BREADTH_STEP * min(distinctFiles_t - 1, BREADTH_MAX_EXTRA))
 *   combined        c    = 1 - product over present tiers of (1 - S_t)        (noisy-or)
 *   cap             c    = min(c, UNCORROBORATED_CEILING)
 *                          unless the claim has >= SERVE_MIN_TIERS tiers AND a T3 row
 *   confidence      round(c, 3)
 *
 * Only rows with s_i > 0 count (a zero-confidence row is not evidence of a tier).
 * A claim is served when withheld_reason is NULL, which fuse.ts decides from:
 * confidence >= SERVE_MIN_CONFIDENCE, tiers >= SERVE_MIN_TIERS, a T3 row, a
 * project reference, and no conflict.
 *
 * Properties that hold by construction (and are tested):
 *   - order independent: max, counts and a product taken in the fixed tier order;
 *   - a second tier raises the score; more files inside one tier raise it only a little;
 *   - a claim under the cap can never reach SERVE_MIN_CONFIDENCE;
 *   - no input outside 0..1 can push the result outside 0..1.
 *
 * Recency is deliberately NOT in the formula: an old claim is not a weaker claim,
 * it is a less checkable one, and that is carried by the `not_validated` label,
 * never by hiding it below the threshold.
 */
import {
  BREADTH_MAX_EXTRA,
  BREADTH_STEP,
  SERVE_MIN_TIERS,
  TIERS,
  T3_BASE,
  T3_QUOTE_STEP,
  T3_ROLE_STEP,
  TIER_CEILING,
  UNCORROBORATED_CEILING,
  type Tier,
} from './constants';

export interface ScoreRow {
  tier: Tier;
  /** The row's Layer 1 confidence, before the pitch factor. */
  confidence: number;
  fileId: string;
  /** T3 only: a grounded quote and a stated role are present. Ignored for T1 and T2. */
  hasQuote?: boolean;
  hasRole?: boolean;
}

export interface ScoreResult {
  confidence: number;
  /** Tiers with at least one usable row, in T1, T2, T3 order. */
  tiers: Tier[];
  tierScores: Partial<Record<Tier, number>>;
  capped: boolean;
}

export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** A content row's strength: capped by what the mention shows (quote, role). */
export function t3RowStrength(confidence: number, hasQuote: boolean, hasRole: boolean): number {
  const shown = T3_BASE + (hasQuote ? T3_QUOTE_STEP : 0) + (hasRole ? T3_ROLE_STEP : 0);
  return Math.min(clamp01(confidence), shown);
}

export function scoreClaim(rows: readonly ScoreRow[], pitchFactor: number): ScoreResult {
  const tierScores: Partial<Record<Tier, number>> = {};
  for (const tier of TIERS) {
    let best = 0;
    const files = new Set<string>();
    for (const r of rows) {
      if (r.tier !== tier) continue;
      const base =
        tier === 'T3'
          ? t3RowStrength(r.confidence, r.hasQuote === true, r.hasRole === true)
          : clamp01(r.confidence);
      const s = base * pitchFactor;
      if (s <= 0) continue;
      if (s > best) best = s;
      files.add(r.fileId);
    }
    if (files.size === 0) continue;
    const extra = Math.min(files.size - 1, BREADTH_MAX_EXTRA);
    tierScores[tier] = round3(Math.min(TIER_CEILING[tier], best + BREADTH_STEP * extra));
  }

  const tiers = TIERS.filter((t) => tierScores[t] !== undefined);
  let miss = 1;
  for (const t of tiers) miss *= 1 - (tierScores[t] as number);
  let combined = tiers.length === 0 ? 0 : 1 - miss;

  const corroborated = tiers.length >= SERVE_MIN_TIERS && tiers.includes('T3');
  if (!corroborated) combined = Math.min(combined, UNCORROBORATED_CEILING);
  return { confidence: round3(clamp01(combined)), tiers, tierScores, capped: !corroborated };
}
