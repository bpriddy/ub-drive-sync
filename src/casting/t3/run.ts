/**
 * The T3 stage runner: plan, dry-run, apply.
 *
 *   plan     triage -> window / drive rules -> duplicate collapse -> cells; identical-content
 *            copies are set aside as copies of a kept file (see copies.ts)
 *   dry-run  (default) the plan, the estimate, and a $0 resolve preview of any
 *            cells already in the ledger. No model, no sink writes, no files.
 *            `readText` additionally reads documents (zero-cost reads) to size
 *            the estimate with real lengths.
 *   apply    only with `mode: 'apply'` AND an approval ({maxCells, maxCostUsd})
 *            AND a priced model. Refuses before any call when the plan exceeds
 *            the approved cell count; stops launching cells once the spend
 *            reaches the approved ceiling. The model client is created only here,
 *            through `llmFactory`, after every check has passed.
 *
 * Resumable: every finished cell is appended to the ledger; a re-run skips the
 * cells already there (failed cells too, unless `retryFailed`). Idempotent:
 * rows are insert-or-ignore on (extractor_version, claim_hash).
 *
 * Parallelism is capped at T3_MAX_PARALLEL (2); a higher value is an error,
 * not a silent clamp.
 */
import crypto from 'node:crypto';
import type { LlmDriver } from '../../ai/ai.types';
import type { ThinkingLevelName } from '../../ai/thinking';
import type { ResolutionContext, RosterIndex } from '../identity';
import {
  addDecision,
  breakdownOf,
  buildCopyIndex,
  copyRefOf,
  decideCopies,
  newCopyCounts,
  type CopyEdge,
} from './copies';
import { estimateAll, type EstimateTable } from './estimate';
import { groundMentions, type GroundingStats } from './ground';
import {
  cellKeyOf,
  copyCellKeyOf,
  extractorVersionOf,
  type CellConfigSignature,
  type CellRecord,
  type Ledger,
} from './ledger';
import { priceOf } from './pricing';
import type { EvidenceDraft } from './row';
import { buildPrompt } from './prompt';
import { newResolveCounts, resolveLedgerRecords, type ResolveCounts } from './resolve-mentions';
import { mentionsResponseSchema, parseMentionsResponse, type SanitizeStats } from './schema';
import type { T3Sink } from './sink';
import { fitToCap } from './truncate';
import {
  selectCandidates,
  type Selection,
  type SelectionPolicy,
  type SelectedCandidate,
} from './triage';
import { UsageTally, type TagUsage } from './usage';
import {
  T3_CALL_TAG,
  T3_MAX_PARALLEL,
  T3_PROMPT_VERSION,
  type DocumentReader,
  type ReadOutcome,
  type T3Candidate,
} from './types';
import { llmUsageByTag } from '../../ai/usage-tally';

export interface T3Options {
  /** Default 'dry-run'. */
  readonly mode?: 'dry-run' | 'apply' | undefined;
  /** dry-run only: read document text to size the estimate. */
  readonly readText?: boolean | undefined;
  readonly policy: SelectionPolicy;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevelName;
  readonly capChars?: number | undefined;
  readonly parallel?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** Required for apply. The run never exceeds maxCells and stops at maxCostUsd. */
  readonly approval?: { readonly maxCells: number; readonly maxCostUsd: number } | undefined;
  readonly retryFailed?: boolean | undefined;
  /** [ASSUME] length for cells with no measured length (estimates only). */
  readonly fallbackChars?: number | undefined;
  readonly now?: Date | undefined;
}

export interface T3Deps {
  readonly reader: DocumentReader;
  readonly ledger: Ledger;
  readonly sink: T3Sink;
  readonly roster: RosterIndex;
  readonly contextFor?: ((accountId: string) => ResolutionContext | undefined) | undefined;
  /** Called at most once, in apply mode, after all guards pass. */
  readonly llmFactory: () => Promise<LlmDriver>;
  readonly log?: ((msg: string, fields?: Record<string, unknown>) => void) | undefined;
}

export interface QualityCounters {
  cellsFirstTryValid: number;
  cellsRetried: number;
  cellsSchemaFailed: number;
  cellsLlmFailed: number;
  itemsInvalid: number;
  droppedUrlOrId: number;
  droppedBadName: number;
  droppedUngroundedName: number;
  quoteDroppedUngrounded: number;
  quoteTruncated: number;
  quoteLinkRedacted: number;
  mentionsCapped: number;
  docTypeCoerced: number;
  truncatedDocs: number;
  mentionsKept: number;
}

const zeroQuality = (): QualityCounters => ({
  cellsFirstTryValid: 0,
  cellsRetried: 0,
  cellsSchemaFailed: 0,
  cellsLlmFailed: 0,
  itemsInvalid: 0,
  droppedUrlOrId: 0,
  droppedBadName: 0,
  droppedUngroundedName: 0,
  quoteDroppedUngrounded: 0,
  quoteTruncated: 0,
  quoteLinkRedacted: 0,
  mentionsCapped: 0,
  docTypeCoerced: 0,
  truncatedDocs: 0,
  mentionsKept: 0,
});

export interface T3Plan {
  readonly windowStart: string;
  readonly variant: string;
  readonly candidates: number;
  readonly selected: number;
  readonly tierCounts: Selection['tierCounts'];
  readonly excluded: Selection['excluded'];
  readonly duplicatesCollapsed: number;
  readonly cellsAlreadyDone: number;
  readonly cellsToRun: number;
  /** Documents the model will read: one per unique content. */
  readonly documentsToRead: number;
  /**
   * Identical-content copies that receive rows without a model call ($0). `expanded` is
   * over every selected file, `expandedForCellsToRun` only for cells still to run.
   * Rows to be emitted = rows of (documentsToRead + expandedForCellsToRun) documents;
   * mentions per document is [MEASURE: pilot].
   */
  readonly copies: {
    readonly candidates: number;
    readonly expanded: number;
    readonly expandedForCellsToRun: number;
    readonly copy_without_context: number;
    readonly overCap: number;
    readonly byAccountClass: readonly { accountId: string; docClass: string; expanded: number }[];
  };
  /** dry-run with readText: documents the reader could not read, by reason. */
  readonly readSkips: Readonly<Record<string, number>>;
  readonly extractorVersion: string;
}

export interface T3Report {
  readonly mode: 'dry-run' | 'apply';
  readonly plan: T3Plan;
  readonly estimates: EstimateTable[];
  /** Estimate for the cells to run, using measured lengths where known. */
  readonly sizedCells: number;
  readonly unsizedCells: number;
  readonly resolvePreview: ResolveCounts | null;
  readonly run: {
    readonly status: 'success' | 'stopped' | 'failed';
    readonly stoppedReason: 'budget' | null;
    readonly attempted: number;
    readonly ok: number;
    readonly failed: number;
    readonly skipped: number;
    readonly deferred: number;
    readonly quality: QualityCounters;
    readonly resolve: ResolveCounts;
    readonly rowsInserted: number;
    readonly rowsDuplicate: number;
    readonly usage: TagUsage[];
    readonly costUsd: number;
    /** Copies expanded without a model call, reported apart from the priced calls. */
    readonly copies: {
      readonly expanded: number;
      readonly copy_without_context: number;
      readonly overCap: number;
      readonly rows: number;
      readonly foundAtReadTime: number;
      readonly costUsd: 0;
      readonly byAccountClass: readonly { accountId: string; docClass: string; expanded: number }[];
    };
    /** The driver's own per-attempt tally for this tag (billed attempts incl. its retries). */
    readonly driverAttempts: ReturnType<typeof llmUsageByTag>;
    readonly syncRunId: string;
  } | null;
}

const WRITE_BATCH = 500;

function validate(opts: T3Options): { mode: 'dry-run' | 'apply'; parallel: number; cap: number } {
  const mode = opts.mode ?? 'dry-run';
  const parallel = opts.parallel ?? 1;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > T3_MAX_PARALLEL) {
    throw new RangeError(`parallel must be 1..${T3_MAX_PARALLEL}`);
  }
  const cap = opts.capChars ?? 40_000;
  if (!Number.isInteger(cap) || cap < 1000)
    throw new RangeError('capChars must be an integer >= 1000');
  if (mode === 'apply') {
    if (!priceOf(opts.model))
      throw new Error(`apply needs a priced model; no price for ${opts.model}`);
    const a = opts.approval;
    if (!a || !(a.maxCells >= 1) || !(a.maxCostUsd > 0)) {
      throw new Error('apply needs an approval with maxCells >= 1 and maxCostUsd > 0');
    }
  }
  return { mode, parallel, cap };
}

/** Runs `worker` over `items` with at most `n` in flight. */
async function pool<T>(
  items: readonly T[],
  n: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
}

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

export async function runT3(
  opts: T3Options,
  deps: T3Deps,
  candidates: readonly T3Candidate[],
): Promise<T3Report> {
  const { mode, parallel, cap } = validate(opts);
  const log = deps.log ?? (() => undefined);
  const now = opts.now ?? new Date();
  const sig: CellConfigSignature = {
    promptVersion: T3_PROMPT_VERSION,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    capChars: cap,
  };
  const extractorVersion = extractorVersionOf(sig);

  const selection = selectCandidates(candidates, opts.policy);
  const prior = deps.ledger.load();
  const doneKeys = new Set<string>();
  for (const r of prior) {
    if (
      r.status === 'ok' ||
      r.status === 'skipped' ||
      r.status === 'copy' ||
      (r.status === 'failed' && opts.retryFailed !== true)
    ) {
      doneKeys.add(r.cellKey);
    }
  }
  const keyOf = (s: SelectedCandidate): string => cellKeyOf(s.candidate, sig);
  const todo = selection.selected.filter((s) => !doneKeys.has(keyOf(s)));
  const cellsAlreadyDone = selection.selected.length - todo.length;

  const readSkips: Record<string, number> = {};
  const unreadable = new Set<string>();
  const measured = new Map<string, number>();
  if (mode === 'dry-run' && opts.readText === true) {
    await pool(todo, parallel, async (s) => {
      let out: ReadOutcome;
      try {
        out = await deps.reader.read(s.candidate);
      } catch {
        out = { kind: 'skip', reason: 'read_error' };
      }
      if (out.kind === 'skip') {
        readSkips[out.reason] = (readSkips[out.reason] ?? 0) + 1;
        unreadable.add(s.candidate.fileId);
      } else measured.set(s.candidate.fileId, out.text.length);
    });
  }
  const sizeOf = (s: SelectedCandidate): number | undefined =>
    measured.get(s.candidate.fileId) ?? s.candidate.approxChars;
  const sizing = todo.filter((s) => !unreadable.has(s.candidate.fileId)).map(sizeOf);

  const selectionEdges: CopyEdge[] = [];
  for (const s of selection.selected) {
    for (const c of selection.copiesOf.get(s.candidate.fileId) ?? []) {
      selectionEdges.push({ keptCellKey: keyOf(s), ref: copyRefOf(c.candidate, c.docClass) });
    }
  }
  const planIndex = buildCopyIndex(prior, selectionEdges);
  const planCopies = newCopyCounts();
  const todoCopies = newCopyCounts();
  const todoKeys = new Set(todo.map(keyOf));
  let copyCandidates = 0;
  for (const s of selection.selected) {
    const refs = planIndex.get(keyOf(s)) ?? [];
    const d = decideCopies(s.candidate.fileId, refs);
    copyCandidates += d.expand.length + d.withoutContext.length + d.overCap.length;
    addDecision(planCopies, d);
    if (todoKeys.has(keyOf(s))) addDecision(todoCopies, d);
  }

  const estimates = estimateAll({
    cellChars: sizing,
    fallbackChars: opts.fallbackChars,
    expandedCopies: todoCopies.expanded,
  });

  const plan: T3Plan = {
    windowStart: opts.policy.windowStart,
    variant: opts.policy.variant ?? 'base',
    candidates: candidates.length,
    selected: selection.selected.length,
    tierCounts: selection.tierCounts,
    excluded: selection.excluded,
    duplicatesCollapsed: selection.duplicateOf.size,
    cellsAlreadyDone,
    cellsToRun: todo.length,
    documentsToRead: todo.length,
    copies: {
      candidates: copyCandidates,
      expanded: planCopies.expanded,
      expandedForCellsToRun: todoCopies.expanded,
      copy_without_context: planCopies.copy_without_context,
      overCap: planCopies.overCap,
      byAccountClass: breakdownOf(planCopies.byAccountClass),
    },
    readSkips,
    extractorVersion,
  };
  const unsized = sizing.filter((c) => c === undefined && opts.fallbackChars === undefined).length;
  const base = {
    plan,
    estimates,
    sizedCells: sizing.length - unsized,
    unsizedCells: unsized,
  };

  // Resolve preview over cells already in the ledger (zero cost, no writes).
  const selectedKeys = new Set(selection.selected.map(keyOf));
  const resolveFromLedger = (
    records: readonly CellRecord[],
    counts: ResolveCounts,
  ): EvidenceDraft[] =>
    resolveLedgerRecords(
      records,
      {
        roster: deps.roster,
        contextFor: deps.contextFor,
        now,
        selectionEdges,
        selectedKeys,
      },
      counts,
    );

  if (mode === 'dry-run') {
    const counts = newResolveCounts();
    resolveFromLedger(prior, counts);
    return { mode, ...base, resolvePreview: counts, run: null };
  }

  // ---- apply: every guard first, then the client, then the work ----
  const approval = opts.approval as { maxCells: number; maxCostUsd: number };
  if (todo.length > approval.maxCells) {
    throw new Error(
      `plan has ${todo.length} cells to run, above the approved ${approval.maxCells}; nothing was started`,
    );
  }
  const llm = await deps.llmFactory();
  const { syncRunId } = await deps.sink.startRun({ extractorVersion });
  // Record the kept -> copies mapping (md5 copies) so a resumed run expands the same set.
  for (const e of selectionEdges) {
    const key = copyCellKeyOf(e.keptCellKey, e.ref.fileId);
    if (doneKeys.has(key)) continue;
    doneKeys.add(key);
    deps.ledger.append({
      v: 1,
      cellKey: key,
      extractorVersion,
      at: new Date().toISOString(),
      status: 'copy',
      reason: 'md5_copy',
      copyOfCellKey: e.keptCellKey,
      candidate: {
        fileId: e.ref.fileId,
        accountId: e.ref.accountId,
        createdTime: e.ref.createdTime,
        projectRef: e.ref.projectRef,
      },
      docClass: e.ref.docClass,
      contentHash: null,
      docType: null,
      truncated: false,
      sentChars: null,
      attempts: 0,
      usage: null,
      mentions: [],
      sanitizeStats: null,
      groundingStats: null,
    });
  }
  const tally = new UsageTally();
  const quality = zeroQuality();
  const claimedHashes = new Map<string, string>();
  for (const r of prior) {
    if (r.status === 'ok' && r.contentHash && r.extractorVersion === extractorVersion) {
      claimedHashes.set(r.contentHash, r.cellKey);
    }
  }
  let foundAtReadTime = 0;
  let attempted = 0,
    ok = 0,
    failed = 0,
    skipped = 0,
    deferred = 0;
  let stopped = false;

  const record = (
    s: SelectedCandidate,
    fields: Partial<CellRecord> & Pick<CellRecord, 'status'>,
  ): void => {
    const rec: CellRecord = {
      v: 1,
      cellKey: keyOf(s),
      extractorVersion,
      at: new Date().toISOString(),
      reason: null,
      candidate: {
        fileId: s.candidate.fileId,
        accountId: s.candidate.accountId,
        createdTime: s.candidate.createdTime,
        projectRef: s.candidate.projectRef,
      },
      docClass: s.docClass,
      contentHash: null,
      docType: null,
      truncated: false,
      sentChars: null,
      attempts: 0,
      usage: null,
      mentions: [],
      sanitizeStats: null,
      groundingStats: null,
      ...fields,
    };
    deps.ledger.append(rec);
  };

  const processCell = async (s: SelectedCandidate): Promise<void> => {
    if (stopped) {
      deferred++;
      return;
    }
    if (tally.totalCostUsd >= approval.maxCostUsd) {
      stopped = true;
      deferred++;
      return;
    }
    let text: string;
    try {
      const out = await deps.reader.read(s.candidate);
      if (out.kind === 'skip') {
        skipped++;
        record(s, { status: 'skipped', reason: `read:${out.reason}` });
        return;
      }
      text = out.text;
    } catch (err) {
      failed++;
      record(s, { status: 'failed', reason: `read_error:${errText(err)}` });
      return;
    }
    const contentHash = sha(text);
    const first = claimedHashes.get(contentHash);
    if (first !== undefined) {
      // Same content already sent (or sent in an earlier run): no model call. The file is
      // recorded as a copy of that cell and receives its mentions at the resolve step.
      foundAtReadTime++;
      record(s, {
        status: 'copy',
        reason: 'content_copy',
        contentHash,
        copyOfCellKey: first,
      });
      return;
    }
    claimedHashes.set(contentHash, keyOf(s));

    const fit = fitToCap(text, s.docClass, cap);
    if (fit.truncated) quality.truncatedDocs++;
    const prompt = buildPrompt({
      documentName: s.candidate.name,
      folderPath: s.candidate.ancestors,
      text: fit.text,
    });

    attempted++;
    let attempts = 0;
    let usageSum = { promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, costUsd: 0 };
    let parsed: ReturnType<typeof parseMentionsResponse> = { ok: false, error: 'no_attempt' };
    for (let attempt = 1; attempt <= 2 && !parsed.ok; attempt++) {
      attempts = attempt;
      try {
        const res = await llm.complete({
          model: opts.model,
          temperature: opts.temperature ?? 0,
          prompt,
          tag: T3_CALL_TAG,
          responseSchema: mentionsResponseSchema(),
          thinkingLevel: opts.thinkingLevel,
          ...(opts.maxOutputTokens !== undefined
            ? { maxOutputTokens: opts.maxOutputTokens }
            : { maxOutputTokens: 12_000 }),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
        const { costUsd } = tally.record(T3_CALL_TAG, opts.model, s.docClass, res.usage);
        usageSum = {
          promptTokens: usageSum.promptTokens + (res.usage?.promptTokens ?? 0),
          outputTokens: usageSum.outputTokens + (res.usage?.outputTokens ?? 0),
          thoughtsTokens: usageSum.thoughtsTokens + (res.usage?.thoughtsTokens ?? 0),
          costUsd: usageSum.costUsd + costUsd,
        };
        parsed = parseMentionsResponse(res.text);
      } catch (err) {
        failed++;
        quality.cellsLlmFailed++;
        record(s, {
          status: 'failed',
          reason: `llm_error:${errText(err)}`,
          contentHash,
          attempts,
          usage: attempts > 1 || usageSum.promptTokens > 0 ? usageSum : null,
        });
        return;
      }
    }
    if (!parsed.ok) {
      failed++;
      quality.cellsSchemaFailed++;
      record(s, {
        status: 'failed',
        reason: `schema_invalid:${parsed.error}`,
        contentHash,
        attempts,
        usage: usageSum,
      });
      return;
    }
    if (attempts === 1) quality.cellsFirstTryValid++;
    else quality.cellsRetried++;
    const grounded = groundMentions(fit.text, parsed.mentions);
    addSanitize(quality, parsed.stats);
    addGround(quality, grounded.stats);
    quality.mentionsKept += grounded.mentions.length;
    ok++;
    record(s, {
      status: 'ok',
      contentHash,
      docType: parsed.docType,
      truncated: fit.truncated,
      sentChars: fit.sentChars,
      attempts,
      usage: usageSum,
      mentions: grounded.mentions,
      sanitizeStats: parsed.stats,
      groundingStats: grounded.stats,
    });
  };

  let status: 'success' | 'stopped' | 'failed' = 'success';
  let rowsInserted = 0;
  let rowsDuplicate = 0;
  const resolveCounts = newResolveCounts();
  try {
    await pool(todo, parallel, processCell);
    if (stopped) status = 'stopped';
    const all = resolveFromLedger(deps.ledger.load(), resolveCounts).map((d) => d.row);
    for (let i = 0; i < all.length; i += WRITE_BATCH) {
      const w = await deps.sink.writeEvidence(syncRunId, all.slice(i, i + WRITE_BATCH));
      rowsInserted += w.inserted;
      rowsDuplicate += w.duplicates;
    }
  } catch (err) {
    status = 'failed';
    log('t3 run failed', { err: errText(err) });
    await deps.sink.finishRun(syncRunId, {
      status,
      summary: { cells: attempted, rows: rowsInserted, costUsd: tally.totalCostUsd },
    });
    throw err;
  }
  await deps.sink.finishRun(syncRunId, {
    status,
    summary: { cells: attempted, rows: rowsInserted, costUsd: tally.totalCostUsd },
  });
  return {
    mode,
    ...base,
    resolvePreview: null,
    run: {
      status,
      stoppedReason: status === 'stopped' ? 'budget' : null,
      attempted,
      ok,
      failed,
      skipped,
      deferred,
      quality,
      resolve: resolveCounts,
      rowsInserted,
      rowsDuplicate,
      usage: tally.snapshot(),
      costUsd: Math.round(tally.totalCostUsd * 10_000) / 10_000,
      copies: {
        expanded: resolveCounts.copies.expanded,
        copy_without_context: resolveCounts.copies.copy_without_context,
        overCap: resolveCounts.copies.overCap,
        rows: resolveCounts.copies.rows,
        foundAtReadTime,
        costUsd: 0,
        byAccountClass: breakdownOf(resolveCounts.copies.byAccountClass),
      },
      driverAttempts: llmUsageByTag().filter((u) => u.tag === T3_CALL_TAG),
      syncRunId,
    },
  };
}

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 200);

function addSanitize(q: QualityCounters, s: SanitizeStats): void {
  q.itemsInvalid += s.itemsInvalid;
  q.droppedUrlOrId += s.droppedUrlOrId;
  q.droppedBadName += s.droppedBadName;
  q.quoteTruncated += s.quoteTruncated;
  q.quoteLinkRedacted += s.quoteLinkRedacted;
  q.mentionsCapped += s.mentionsCapped;
  if (s.docTypeCoerced) q.docTypeCoerced++;
}

function addGround(q: QualityCounters, s: GroundingStats): void {
  q.droppedUngroundedName += s.droppedUngroundedName;
  q.quoteDroppedUngrounded += s.quoteDroppedUngrounded;
}
