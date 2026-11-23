/**
 * Re-scan plan for an `extractor_version` bump (S9 task 2): which cells would a new extractor
 * version need, and what would they cost? PLAN ONLY. This file has no apply path, no model
 * client and no sink: it reads a listing and earlier ledgers and prints counts.
 *
 * A new prompt version, model or thinking level changes every cell key, so the incremental
 * selection under the NEW signature returns the whole shortlist as "to pay"; the plan splits that
 * set into cells an earlier version already extracted (re-extraction) and cells never extracted.
 * The paid run itself is the ordinary `casting-run --incremental --apply-t3 ...`, with its own
 * single-use approval, caps and `--expect-cells`; nothing here approves or starts it.
 *
 * Hermetic: node:path only plus the stage's pure modules; the listing arrives through `RescanIo`.
 */
import path from 'node:path';
import { ASSUMPTION_PRESETS, estimate, estimateAll, PRESETS_CALIBRATION } from '../t3/estimate';
import { extractorVersionOf, type CellConfigSignature } from '../t3/ledger';
import { parsePilotArgs } from '../t3/pilot-args';
import { PILOT_CAP_CHARS, PILOT_FALLBACK_CHARS } from '../t3/pilot';
import { priceOf } from '../t3/pricing';
import { formatProposal } from '../t3/proposal';
import { selectCandidates } from '../t3/triage';
import { T3_PROMPT_VERSION, type T3Candidate } from '../t3/types';
import { planIncremental } from './incremental';
import { readPriorLedgers } from './prior-ledgers';

export const RESCAN_EXIT = { planned: 3, failed: 1, refused: 2 } as const;

export interface RescanArgs {
  readonly accountId: string;
  readonly windowStart: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly variant: string;
  readonly ledgerDir: string;
  readonly retryFailed: boolean;
}

const FLAGS = new Set([
  '--account-id',
  '--window-start',
  '--model',
  '--thinking',
  '--variant',
  '--ledger-dir',
  '--retry-failed',
]);

/**
 * Parsed with the pilot's own parser (same validation, same defaults) after refusing anything
 * that could mean "run": there is no `--apply` here, and one is an error, not an ignored flag.
 */
export function parseRescanArgs(argv: readonly string[]): RescanArgs {
  for (const a of argv) {
    if (a.startsWith('--apply')) {
      throw new Error('the re-scan plan never runs the model: use casting-run for the paid run');
    }
    if (a.startsWith('--') && !FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
  }
  const p = parsePilotArgs([...argv, '--sample-seed', 'rescan-plan', '--incremental']);
  if (p.ledgerDir === null) throw new Error('--ledger-dir is required');
  return {
    accountId: p.accountId.toLowerCase(),
    windowStart: p.windowStart,
    model: p.model,
    thinkingLevel: p.thinkingLevel,
    variant: p.variant,
    ledgerDir: path.resolve(p.ledgerDir),
    retryFailed: p.retryFailed,
  };
}

export interface RescanIo {
  loadCandidates(accountId: string): Promise<readonly T3Candidate[]>;
  /** The checkout; only passed through to the read-only ledger reader. */
  readonly repoRoot: string;
  print(line: string): void;
}

export interface RescanReport {
  readonly targetVersion: string;
  readonly earlierLedgers: number;
  readonly earlierVersions: Readonly<Record<string, number>>;
  readonly shortlist: number;
  readonly alreadyDone: number;
  readonly paidContentCopies: number;
  readonly toPay: number;
  /** Of `toPay`: files an earlier version already extracted (a re-extraction). */
  readonly reExtraction: number;
  readonly neverExtracted: number;
  readonly byClass: Readonly<Record<string, number>>;
  readonly baseCostUsd: number | null;
}

export async function runRescanPlan(args: RescanArgs, io: RescanIo): Promise<RescanReport> {
  const sig: CellConfigSignature = {
    promptVersion: T3_PROMPT_VERSION,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    capChars: PILOT_CAP_CHARS,
  };
  const targetVersion = extractorVersionOf(sig);
  const prior = readPriorLedgers(args.ledgerDir, args.accountId, io.repoRoot);
  const earlierVersions: Record<string, number> = {};
  const extractedFiles = new Set<string>();
  for (const r of prior.records) {
    if (r.status !== 'ok') continue;
    earlierVersions[r.extractorVersion] = (earlierVersions[r.extractorVersion] ?? 0) + 1;
    extractedFiles.add(r.candidate.fileId);
  }

  const candidates = await io.loadCandidates(args.accountId);
  const selection = selectCandidates(candidates, {
    windowStart: args.windowStart,
    variant: args.variant as 'tight' | 'base' | 'recall_max',
  });
  const inc = planIncremental(selection, sig, prior.records, { retryFailed: args.retryFailed });
  const reExtraction = inc.toPay.filter((s) => extractedFiles.has(s.candidate.fileId)).length;
  const byClass: Record<string, number> = {};
  for (const s of inc.toPay) byClass[s.docClass] = (byClass[s.docClass] ?? 0) + 1;

  // Sizes are not read here (no document is opened): every cell is priced at the stage's
  // fallback length, which is an [ASSUME], the same one the paid run's own preview uses.
  const cellChars = inc.toPay.map(() => PILOT_FALLBACK_CHARS);
  const table = estimateAll({ cellChars });
  const baseCostUsd = priceOf(args.model)
    ? (estimate(args.model, { cellChars }, ASSUMPTION_PRESETS.base)?.costUsd ?? null)
    : null;

  io.print(
    formatProposal({
      cells: inc.toPay.length,
      accounts: args.accountId,
      thinkingLevel: args.thinkingLevel,
      parallel: 1,
      estimates: [...table].sort(
        (a, b) => Number(b.model === args.model) - Number(a.model === args.model),
      ),
    }),
  );
  io.print('');
  io.print(
    'RE-SCAN PLAN (nothing was run: no model call, no read of any document, nothing written)',
  );
  io.print(
    `target extractor version: ${targetVersion}   window-start: ${args.windowStart}   variant: ${args.variant}`,
  );
  io.print(
    `earlier ledgers read: ${prior.ledgers}   ok cells by extractor version: ${
      Object.keys(earlierVersions).length > 0
        ? Object.keys(earlierVersions)
            .sort()
            .map((v) => `${v} ${earlierVersions[v]}`)
            .join(', ')
        : 'none'
    }`,
  );
  io.print(
    `shortlist ${selection.selected.length}; already extracted under the target version ${inc.unchanged}; $0 copies of paid content ${inc.paidContent}; cells to pay ${inc.toPay.length} (re-extraction of earlier versions ${reExtraction}, never extracted ${inc.toPay.length - reExtraction})`,
  );
  io.print(
    `cells to pay by class: ${
      Object.keys(byClass)
        .sort()
        .map((c) => `${c} ${byClass[c]}`)
        .join(', ') || 'none'
    }`,
  );
  io.print(
    `cost basis: every cell priced at [ASSUME ${PILOT_FALLBACK_CHARS}] chars (no document was read); presets ${PRESETS_CALIBRATION}`,
  );
  io.print(
    inc.toPay.length === 0
      ? 'nothing to re-scan under this version.'
      : `to run it: casting-run --incremental --apply-t3 --expect-cells ${inc.toPay.length} --max-cells ${inc.toPay.length} --max-usd <cap above the base estimate> --ledger-dir <new dir> ...  (needs its own approval in the current message)`,
  );

  return {
    targetVersion,
    earlierLedgers: prior.ledgers,
    earlierVersions,
    shortlist: selection.selected.length,
    alreadyDone: inc.unchanged,
    paidContentCopies: inc.paidContent,
    toPay: inc.toPay.length,
    reExtraction,
    neverExtracted: inc.toPay.length - reExtraction,
    byClass,
    baseCostUsd,
  };
}
