/**
 * Pre-run cost estimate, $0 and local. Same formula as the master spec:
 *
 *   cost = cells x ( (overhead + min(chars, cap) / chars_per_token) x P_in
 *                    + (tokens_out + tokens_thoughts) x P_out ) x retry_factor
 *
 * The three presets are the low / base / high parameter sets.
 *
 * calibrated: pilot P1 (2026-11-20). `base` holds the values measured in pilot P1
 * (118 model calls, gemini-3.5-flash, thinking LOW); `low` and `high` are bounds
 * around that measurement, see the comments on each preset.
 *
 * Still [ASSUME]: the Flash Lite token use. Pilot P1 ran Flash only, so the same
 * token figures are applied to the Flash Lite prices. Cached input is not
 * discounted (see pricing.ts), so the input side stays an upper bound.
 *
 * A cell with no `approxChars` cannot be sized. It is counted in
 * `unsizedCells` and the estimate is marked incomplete rather than guessed;
 * a caller may pass `fallbackChars` ([ASSUME]) to size them anyway.
 */
import { MODEL_PRICES, priceOf } from './pricing';

export interface CostAssumptions {
  readonly charsPerToken: number;
  readonly overheadTokens: number;
  readonly tokensOut: number;
  readonly tokensThoughts: number;
  readonly retryFactor: number;
  readonly capChars: number;
}

/** Version tag of the preset values, exported so tests and callers can pin the calibration. */
export const PRESETS_CALIBRATION = 'pilot P1 (2026-11-20)';

/**
 * Pilot P1 measurements (118 calls, Flash, thinking LOW): prompt overhead ~940 tokens
 * (linear fit of prompt tokens on sent characters; an earlier local measurement gave 852),
 * 3.55 characters per token of document text, mean 336 output tokens per call, mean 12
 * thought tokens per call (0 on every class except slides), no retries, 9 of 118 documents
 * at the 40,000-character cap, mean cost $0.00963 per document on the S5a shortlist mix.
 *
 * `tokensThoughts` is measured at thinking LOW only. It is NOT valid for MEDIUM or HIGH
 * (those think far longer); `formatProposal` warns when the level is not LOW.
 */
export const ASSUMPTION_PRESETS = {
  // Bounds below the measurement: the earlier local overhead figure (852 ~ 850), a
  // text-light mix at 4.0 chars/token, short outputs, no thoughts, no retries.
  low: {
    charsPerToken: 4.0,
    overheadTokens: 850,
    tokensOut: 250,
    tokensThoughts: 0,
    retryFactor: 1.0,
    capChars: 40_000,
  },
  // Measured in pilot P1. retryFactor is 1.05, not the measured 1.0: 0 retries in 118
  // calls bounds the true rate only to about 2.5% (95%, rule of three), so a 5% margin
  // is kept until a larger run measures it. Every other value is the measurement as is.
  base: {
    charsPerToken: 3.55,
    overheadTokens: 940,
    tokensOut: 336,
    tokensThoughts: 12,
    retryFactor: 1.05,
    capChars: 40_000,
  },
  // Bounds above the measurement: overhead with a larger schema or prompt, denser text
  // (3.0 chars/token), long outputs, slides-heavy thoughts, a 20% retry rate. capChars
  // stays 80,000: it prices a raised input cap, as before (the pilot cap is 40,000).
  high: {
    charsPerToken: 3.0,
    overheadTokens: 1100,
    tokensOut: 600,
    tokensThoughts: 200,
    retryFactor: 1.2,
    capChars: 80_000,
  },
} as const satisfies Record<string, CostAssumptions>;

export type PresetName = keyof typeof ASSUMPTION_PRESETS;

export interface EstimateInput {
  /** One entry per planned cell: its approximate extracted length, or undefined when unmeasured. */
  readonly cellChars: readonly (number | undefined)[];
  readonly fallbackChars?: number | undefined;
  /**
   * Identical-content copies that will receive rows from a cell's extraction.
   * They add rows, not model calls: reported as expanded at $0, never priced.
   */
  readonly expandedCopies?: number | undefined;
}

export interface Estimate {
  readonly cells: number;
  readonly unsizedCells: number;
  readonly complete: boolean;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  /** Copies expanded without a model call. */
  readonly expandedCopies: number;
  readonly expandedCostUsd: 0;
}

export function estimate(model: string, input: EstimateInput, a: CostAssumptions): Estimate | null {
  const price = priceOf(model);
  if (!price) return null;
  let unsized = 0;
  let tokensIn = 0;
  for (const raw of input.cellChars) {
    const chars = raw ?? input.fallbackChars;
    if (chars === undefined) {
      unsized++;
      continue;
    }
    tokensIn += a.overheadTokens + Math.min(chars, a.capChars) / a.charsPerToken;
  }
  const sized = input.cellChars.length - unsized;
  const tokensOut = sized * (a.tokensOut + a.tokensThoughts);
  const cost = ((tokensIn * price.inputPerM + tokensOut * price.outputPerM) / 1e6) * a.retryFactor;
  return {
    cells: input.cellChars.length,
    unsizedCells: unsized,
    complete: unsized === 0,
    tokensIn: Math.round(tokensIn * a.retryFactor),
    tokensOut: Math.round(tokensOut * a.retryFactor),
    costUsd: Math.round(cost * 100) / 100,
    expandedCopies: input.expandedCopies ?? 0,
    expandedCostUsd: 0,
  };
}

export interface EstimateTable {
  readonly model: string;
  readonly low: Estimate;
  readonly base: Estimate;
  readonly high: Estimate;
}

/** Low / base / high for every priced model. */
export function estimateAll(input: EstimateInput): EstimateTable[] {
  return Object.keys(MODEL_PRICES).map((model) => ({
    model,
    low: estimate(model, input, ASSUMPTION_PRESETS.low) as Estimate,
    base: estimate(model, input, ASSUMPTION_PRESETS.base) as Estimate,
    high: estimate(model, input, ASSUMPTION_PRESETS.high) as Estimate,
  }));
}
