/**
 * Per-tag token accounting for one run, computed from the usage the driver
 * reports on each completion (input, output, thoughts), with a breakdown by
 * document class and the quality counters the pilot report needs.
 *
 * Billed attempts the driver retries internally (429, 5xx, cut-off answers)
 * never reach a result, so this tally sees only the final attempt of each
 * call; the driver's own per-attempt tally (ai/usage-tally.ts) is the
 * reconciliation source on a real run and is read into the summary.
 */
import type { LlmUsage } from '../../ai/ai.types';
import { costUsd } from './pricing';
import type { DocClass } from './types';

export interface TokenTotals {
  calls: number;
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  cachedContentTokens: number;
  costUsd: number;
}

const zero = (): TokenTotals => ({
  calls: 0,
  promptTokens: 0,
  outputTokens: 0,
  thoughtsTokens: 0,
  cachedContentTokens: 0,
  costUsd: 0,
});

export interface TagUsage extends TokenTotals {
  tag: string;
  model: string;
  byClass: Partial<Record<DocClass, TokenTotals>>;
}

export class UsageTally {
  private readonly rows = new Map<string, TagUsage>();

  record(
    tag: string,
    model: string,
    docClass: DocClass,
    usage: LlmUsage | undefined,
  ): { costUsd: number } {
    const counts = {
      promptTokens: usage?.promptTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      thoughtsTokens: usage?.thoughtsTokens ?? 0,
    };
    const cost = costUsd(model, counts) ?? 0;
    const key = `${tag}|${model}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { ...zero(), tag, model, byClass: {} };
      this.rows.set(key, row);
    }
    const add = (t: TokenTotals): void => {
      t.calls++;
      t.promptTokens += counts.promptTokens;
      t.outputTokens += counts.outputTokens;
      t.thoughtsTokens += counts.thoughtsTokens;
      t.cachedContentTokens += usage?.cachedContentTokens ?? 0;
      t.costUsd += cost;
    };
    add(row);
    const byClass = (row.byClass[docClass] ??= zero());
    add(byClass);
    return { costUsd: cost };
  }

  /** Total spent so far across all tags. */
  get totalCostUsd(): number {
    let sum = 0;
    for (const r of this.rows.values()) sum += r.costUsd;
    return sum;
  }

  snapshot(): TagUsage[] {
    return [...this.rows.values()].sort((a, b) => b.costUsd - a.costUsd);
  }
}
