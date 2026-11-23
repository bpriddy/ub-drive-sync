/**
 * Incremental selection for T3 (S9 tasks 1 and 6): from the current shortlist, keep only the
 * cells that still need a model call.
 *
 * A cell is `cellKeyOf(file, content version, prompt, model, thinking, cap)`. The content
 * version token is the Drive md5 (Google-native files have none: their modified time). So:
 *
 *   - unchanged file, same extractor version  -> same key -> already paid -> not selected;
 *   - changed file (new md5 / new modified time) -> new key -> selected;
 *   - new extractor version (any part of the signature) -> every key is new -> selected
 *     (that is the re-scan, see rescan-plan.ts);
 *   - a window slide changes no key (the window is not in it), so history is never re-paid.
 *
 * Identical content that a prior ledger already paid is a $0 copy, as in the stage's own copy
 * logic (copies.ts): a new file with the md5 of a paid cell, and a new listing copy of a paid
 * cell, become `carries`: copy lines that the loader expands into rows for the copy's own file,
 * account and project. They are never sent to the model.
 *
 * Pure: no I/O, no clock. A day with no change gives `toPay = []` and `carries = []`.
 */
import { copyRefOf, type CopyRef } from '../t3/copies';
import {
  cellKeyOf,
  copyCellKeyOf,
  extractorVersionOf,
  type CellConfigSignature,
  type CellRecord,
} from '../t3/ledger';
import type { SelectedCandidate, Selection } from '../t3/triage';

export interface CarryCopy {
  /** Cell key of the paid kept cell (it lives in a prior ledger). */
  readonly keptCellKey: string;
  readonly ref: CopyRef;
  /** Why it is a copy: the listing already grouped it with a paid cell, or its md5 matches one. */
  readonly why: 'listing_copy' | 'md5_paid';
}

export interface IncrementalPlan {
  /** Kept cells that need a model call (new or changed content, or a new extractor version). */
  readonly toPay: readonly SelectedCandidate[];
  /** $0 copies of content a prior ledger paid: lines for the new ledger, never a model call. */
  readonly carries: readonly CarryCopy[];
  /** Kept cells of the shortlist that a prior ledger already holds under this signature. */
  readonly unchanged: number;
  /** Kept cells that are new files but hold content a prior ledger already paid ($0 copies). */
  readonly paidContent: number;
  /** Cells selected only because a prior failed cell is retried (`retryFailed`). */
  readonly retried: number;
  /** Prior records looked at. */
  readonly priorRecords: number;
}

/** The stage's own done rule (run.ts): ok, skipped and copy cells are done; failed ones unless retried. */
export function doneKeysOf(
  records: readonly CellRecord[],
  retryFailed: boolean,
): { done: Set<string>; failed: Set<string> } {
  const done = new Set<string>();
  const failed = new Set<string>();
  for (const r of records) {
    if (r.status === 'ok' || r.status === 'skipped' || r.status === 'copy') done.add(r.cellKey);
    else if (r.status === 'failed') {
      failed.add(r.cellKey);
      if (!retryFailed) done.add(r.cellKey);
    }
  }
  return { done, failed };
}

export function planIncremental(
  selection: Selection,
  sig: CellConfigSignature,
  prior: readonly CellRecord[],
  options: { readonly retryFailed?: boolean | undefined } = {},
): IncrementalPlan {
  const retryFailed = options.retryFailed === true;
  const { done, failed } = doneKeysOf(prior, retryFailed);
  const version = extractorVersionOf(sig);
  // md5 -> the first paid ok cell of this extractor version that carries it (records are in a
  // stable order, so the choice is deterministic).
  const paidByMd5 = new Map<string, string>();
  for (const r of prior) {
    const md5 = r.candidate.md5Checksum;
    if (r.status === 'ok' && r.extractorVersion === version && md5 && !paidByMd5.has(md5)) {
      paidByMd5.set(md5, r.cellKey);
    }
  }

  const toPay: SelectedCandidate[] = [];
  const carries: CarryCopy[] = [];
  const carried = new Set<string>();
  const carry = (keptCellKey: string, s: SelectedCandidate, why: CarryCopy['why']): void => {
    const key = copyCellKeyOf(keptCellKey, s.candidate.fileId);
    if (done.has(key) || carried.has(key)) return;
    carried.add(key);
    carries.push({ keptCellKey, ref: copyRefOf(s.candidate, s.docClass), why });
  };

  let unchanged = 0;
  let paidContent = 0;
  let retried = 0;
  for (const s of selection.selected) {
    const key = cellKeyOf(s.candidate, sig);
    const copies = selection.copiesOf.get(s.candidate.fileId) ?? [];
    if (done.has(key)) {
      unchanged++;
      // A copy that appeared next to a paid file since the last run.
      for (const c of copies) carry(key, c, 'listing_copy');
      continue;
    }
    const md5 = s.candidate.md5Checksum;
    const paid = md5 ? paidByMd5.get(md5) : undefined;
    if (paid !== undefined) {
      paidContent++;
      carry(paid, s, 'md5_paid');
      for (const c of copies) carry(paid, c, 'md5_paid');
      continue;
    }
    if (failed.has(key)) retried++;
    toPay.push(s);
  }
  return { toPay, carries, unchanged, paidContent, retried, priorRecords: prior.length };
}
