/**
 * Identical-content copies: one model run per unique content, rows for every
 * project that holds a copy.
 *
 * A copy (same md5 in another folder, or same extracted text found at read
 * time) is never sent to the model. The mentions found in the KEPT file are
 * bound to each copy: same raw names, roles, quotes and period text, but the
 * copy's own file_id, account and project reference, resolved through S3 with
 * the copy's own context (account gate, evidence date). Expansion costs no
 * model tokens and is reported separately as "expanded, $0".
 *
 * Rules:
 *  - only identical-content copies are expanded; a version family (different
 *    content, newest wins) is never expanded;
 *  - a copy with no usable project context emits nothing and is counted
 *    (copy_without_context); it never borrows the kept file's project;
 *  - at most COPIES_PER_KEPT_CAP copies are expanded per kept file, in file-id
 *    order (stable across runs); the rest are counted as overflow, so a template
 *    copied hundreds of times cannot flood the evidence table.
 */
import type { CellRecord } from './ledger';
import type { DocClass, T3Candidate } from './types';

/**
 * [ASSUME: 25] Copies expanded per kept file. No S1 report measures how many
 * copies a unique document has. [MEASURE: dry-run, `plan.copies` and its
 * overflow counter, on the real shortlist.]
 */
export const COPIES_PER_KEPT_CAP = 25;

export interface CopyRef {
  readonly fileId: string;
  readonly accountId: string;
  readonly createdTime: string | null;
  readonly projectRef: T3Candidate['projectRef'];
  readonly docClass: DocClass;
}

export function copyRefOf(c: T3Candidate, docClass: DocClass): CopyRef {
  return {
    fileId: c.fileId,
    accountId: c.accountId,
    createdTime: c.createdTime,
    projectRef: c.projectRef,
    docClass,
  };
}

/** An account and at least one project reference (job number, campaign or piece) of the copy itself. */
export function hasProjectContext(c: Pick<CopyRef, 'accountId' | 'projectRef'>): boolean {
  if (!c.accountId) return false;
  const p = c.projectRef;
  return Boolean(p && (p.jobNumber || p.campaignId || p.pieceId));
}

export interface CopyDecision {
  readonly expand: readonly CopyRef[];
  readonly withoutContext: readonly CopyRef[];
  readonly overCap: readonly CopyRef[];
}

/** Which copies of one kept file get rows. Deterministic: sorted by file id, deduplicated. */
export function decideCopies(
  keptFileId: string,
  copies: readonly CopyRef[],
  cap: number = COPIES_PER_KEPT_CAP,
): CopyDecision {
  const byId = new Map<string, CopyRef>();
  for (const c of copies) if (c.fileId !== keptFileId && !byId.has(c.fileId)) byId.set(c.fileId, c);
  const sorted = [...byId.values()].sort((a, b) =>
    a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0,
  );
  const expand: CopyRef[] = [];
  const withoutContext: CopyRef[] = [];
  const overCap: CopyRef[] = [];
  for (const c of sorted) {
    if (!hasProjectContext(c)) withoutContext.push(c);
    else if (expand.length < cap) expand.push(c);
    else overCap.push(c);
  }
  return { expand, withoutContext, overCap };
}

export interface CopyCounts {
  /** Copies that received rows (a copy whose kept file produced no mention still counts). */
  expanded: number;
  /** Copies with no usable project context: nothing emitted. */
  copy_without_context: number;
  /** Copies beyond the per-kept cap: nothing emitted. */
  overCap: number;
  /** Layer 1 rows emitted for copies (also included in the totals by person kind). */
  rows: number;
  /** Expanded copies per `${accountId}|${docClass}`. */
  byAccountClass: Record<string, number>;
}

export const newCopyCounts = (): CopyCounts => ({
  expanded: 0,
  copy_without_context: 0,
  overCap: 0,
  rows: 0,
  byAccountClass: {},
});

export function addDecision(counts: CopyCounts, d: CopyDecision): void {
  counts.expanded += d.expand.length;
  counts.copy_without_context += d.withoutContext.length;
  counts.overCap += d.overCap.length;
  for (const c of d.expand) {
    const key = `${c.accountId}|${c.docClass}`;
    counts.byAccountClass[key] = (counts.byAccountClass[key] ?? 0) + 1;
  }
}

/** The per-account, per-class breakdown as a sorted list (for reports and the proposal text). */
export function breakdownOf(
  byAccountClass: Readonly<Record<string, number>>,
): { accountId: string; docClass: string; expanded: number }[] {
  return Object.entries(byAccountClass)
    .map(([k, expanded]) => {
      const [accountId = '', docClass = ''] = k.split('|');
      return { accountId, docClass, expanded };
    })
    .sort((a, b) => (a.accountId + a.docClass < b.accountId + b.docClass ? -1 : 1));
}

/** A copy known from the current selection: bound to the cell key of its kept file. */
export interface CopyEdge {
  readonly keptCellKey: string;
  readonly ref: CopyRef;
}

/**
 * kept cell key -> every copy that receives its mentions: the md5 copies of the
 * current selection and every `copy` line of the ledger (the recorded mapping).
 * A copy found at read time may itself have md5 copies; they follow it to the
 * kept file at the end of its chain.
 */
export function buildCopyIndex(
  records: readonly CellRecord[],
  selectionEdges: readonly CopyEdge[],
): Map<string, CopyRef[]> {
  const parentOf = new Map<string, string>();
  const edges: CopyEdge[] = [...selectionEdges];
  for (const r of records) {
    if (r.status !== 'copy' || !r.copyOfCellKey) continue;
    parentOf.set(r.cellKey, r.copyOfCellKey);
    edges.push({
      keptCellKey: r.copyOfCellKey,
      ref: {
        fileId: r.candidate.fileId,
        accountId: r.candidate.accountId,
        createdTime: r.candidate.createdTime,
        projectRef: r.candidate.projectRef,
        docClass: r.docClass,
      },
    });
  }
  const rootOf = (key: string): string => {
    const seen = new Set<string>();
    let k = key;
    for (let p = parentOf.get(k); p !== undefined && !seen.has(k); p = parentOf.get(k)) {
      seen.add(k);
      k = p;
    }
    return k;
  };
  const index = new Map<string, CopyRef[]>();
  for (const e of edges) {
    const root = rootOf(e.keptCellKey);
    const list = index.get(root) ?? [];
    list.push(e.ref);
    index.set(root, list);
  }
  return index;
}
