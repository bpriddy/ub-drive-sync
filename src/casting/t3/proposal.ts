/**
 * The pre-run proposal text (workspace CLAUDE.md protocol): cell count, arms,
 * estimated cost. Output only; producing it starts nothing and approves nothing.
 */
import type { EstimateTable } from './estimate';

export function formatProposal(input: {
  readonly cells: number;
  readonly accounts: string;
  readonly thinkingLevel: string;
  readonly parallel: number;
  readonly estimates: readonly EstimateTable[];
}): string {
  const lines = [
    'PROPOSAL (no run started)',
    `cells (files): ${input.cells}   account: ${input.accounts}`,
    `arms: ${input.estimates.map((e) => e.model).join(' | ')}   thinking: ${input.thinkingLevel}   parallel <= ${input.parallel}`,
  ];
  for (const e of input.estimates) {
    const note = e.base.complete
      ? ''
      : `   [${e.base.unsizedCells} cells unsized: estimate incomplete]`;
    lines.push(
      `estimated cost ${e.model}: low $${e.low.costUsd} / base $${e.base.costUsd} / high $${e.high.costUsd}${note}`,
    );
  }
  lines.push('approval covers this single run only');
  return lines.join('\n');
}
