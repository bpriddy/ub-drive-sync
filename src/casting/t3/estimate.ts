/**
 * Pre-run cost estimate, $0 and local. Same formula as the master spec:
 *
 *   cost = cells x ( (overhead + min(chars, cap) / chars_per_token) x P_in
 *                    + (tokens_out + tokens_thoughts) x P_out ) x retry_factor
 *
 * The three presets are the S1.2 low / base / high parameter sets. Every value
 * is an [ASSUME] until a pilot measures it: chars per token (no tokenizer was
 * run), prompt overhead (measurable locally: see `promptOverheadChars`),
 * output and thoughts tokens per call, retry factor.
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

export const ASSUMPTION_PRESETS = {
  low: {
    charsPerToken: 4.5,
    overheadTokens: 1500,
    tokensOut: 150,
    tokensThoughts: 0,
    retryFactor: 1.0,
    capChars: 40_000,
  },
  base: {
    charsPerToken: 4.0,
    overheadTokens: 2000,
    tokensOut: 400,
    tokensThoughts: 400,
    retryFactor: 1.1,
    capChars: 40_000,
  },
  high: {
    charsPerToken: 3.0,
    overheadTokens: 3000,
    tokensOut: 1000,
    tokensThoughts: 2000,
    retryFactor: 1.3,
    capChars: 80_000,
  },
} as const satisfies Record<string, CostAssumptions>;

export type PresetName = keyof typeof ASSUMPTION_PRESETS;

export interface EstimateInput {
  /** One entry per planned cell: its approximate extracted length, or undefined when unmeasured. */
  readonly cellChars: readonly (number | undefined)[];
  readonly fallbackChars?: number | undefined;
}

export interface Estimate {
  readonly cells: number;
  readonly unsizedCells: number;
  readonly complete: boolean;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
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
