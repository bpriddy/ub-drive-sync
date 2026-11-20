/**
 * Prices and the cost of a call. USD per 1M tokens, global endpoint (workspace
 * CLAUDE.md pricing table). Thoughts bill as OUTPUT. Cached input is not
 * discounted here: the estimate is deliberately an upper bound on that side.
 *
 * A model id missing from the table has no price: callers must refuse to run a
 * budgeted (apply) run with it rather than count it as free.
 */
export interface ModelPrice {
  readonly inputPerM: number;
  readonly outputPerM: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gemini-3.5-flash': { inputPerM: 1.5, outputPerM: 9.0 },
  'gemini-3.5-flash-lite': { inputPerM: 0.3, outputPerM: 2.5 },
};

export interface TokenCounts {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtsTokens: number;
}

export function priceOf(model: string): ModelPrice | null {
  return MODEL_PRICES[model] ?? null;
}

export function costUsd(model: string, t: TokenCounts): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (t.promptTokens * p.inputPerM + (t.outputTokens + t.thoughtsTokens) * p.outputPerM) / 1e6;
}
