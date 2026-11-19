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
  /** Documents the model reads vs copies that only receive rows (no model call, $0). */
  readonly copies?:
    | {
        readonly documentsToRead: number;
        readonly expanded: number;
        readonly withoutContext: number;
        readonly overCap: number;
        readonly byAccountClass: readonly {
          accountId: string;
          docClass: string;
          expanded: number;
        }[];
      }
    | undefined;
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
  if (input.copies) {
    const c = input.copies;
    lines.push(
      `documents to read: ${c.documentsToRead}   copies expanded, no model call, $0: ${c.expanded}   (copy_without_context ${c.withoutContext}, over cap ${c.overCap})`,
    );
    for (const b of c.byAccountClass) {
      lines.push(`  copies expanded: ${b.accountId} / ${b.docClass}: ${b.expanded}`);
    }
  }
  lines.push('approval covers this single run only');
  return lines.join('\n');
}
