/**
 * The pilot driver's core (pilot P1: one account, a fixed-size stratified sample of the kept
 * shortlist, results only in the run ledger). Hermetic: it imports no config, Prisma, Drive
 * or model client. Everything real arrives through `PilotIo`, wired by pilot-main.ts.
 *
 * Flow
 *   1. list the account's candidates (io), run the stage's shortlist step (tiers, window,
 *      version collapse, md5 copies), then draw the sample from the KEPT cells only
 *      (sample.ts). Copies are not cells: they are not sampled and never sent to the model;
 *      the sampled cells carry their copies along, so the estimate shows the $0 expansion.
 *   2. guards (ledger directory, cell limit), then print the PROPOSAL block first.
 *   3. dry-run (default): print, touch nothing, exit 3 ("no run started"). The sink and the
 *      model factory handed to the stage in this path throw if anything calls them.
 *   4. apply: only with `--apply` + approval + absolute `--ledger-dir` (parsePilotArgs). The
 *      header (seed, config signature, the sample) is written once; the stage then runs with
 *      a MemorySink, so nothing is written to a database; every cell is appended to the
 *      ledger, which is also the resume point and the input of a later `$0` resolve.
 *
 * The second guard of the paid path is the ledger directory rule (`inspectLedgerDir`): the
 * directory must be absent, empty, or hold a header of the SAME seed and configuration
 * signature (resume). Anything else refuses before a model client exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LlmDriver } from '../../ai/ai.types';
import type { RosterIndex } from '../identity';
import { planIncremental, type IncrementalPlan } from '../maintain/incremental';
import { ChainedLedger, readPriorLedgers, type PriorLedgers } from '../maintain/prior-ledgers';
import type { PilotArgs } from './pilot-args';
import {
  estimate,
  ASSUMPTION_PRESETS,
  PRESETS_CALIBRATION,
  type CostAssumptions,
} from './estimate';
import {
  assertOutsideRepo,
  cellKeyOf,
  copyCellKeyOf,
  extractorVersionOf,
  GuardError,
  MemoryLedger,
  PILOT_HEADER_FILE,
  type CellConfigSignature,
  type Ledger,
  type LedgerHeader,
} from './ledger';
import { MODEL_PRICES, priceOf } from './pricing';
import { formatProposal } from './proposal';
import { runT3, type T3Deps, type T3Report } from './run';
import { stratifiedSample, type SampleResult } from './sample';
import type { T3Sink } from './sink';
import { selectCandidates, type Selection, type SelectionPolicy } from './triage';
import {
  T3_PROMPT_VERSION,
  type DocumentReader,
  type ReadOutcome,
  type T3Candidate,
} from './types';

/** Characters sent per document at most; part of the cell signature, so fixed here. */
export const PILOT_CAP_CHARS = 40_000;

/** [ASSUME: 10000] length of a cell that was not read (apply preview only); S5a measured about 10k for this account. */
export const PILOT_FALLBACK_CHARS = 10_000;

// Defined in ledger.ts (hermetic: no model code) so the ledger loader can use them without
// importing this file; re-exported here for the callers that always had them from the pilot.
export { GuardError, PILOT_HEADER_FILE };
export type { LedgerHeader };

/** Process exit codes. A dry-run exits 3 on purpose: "printed, nothing started". */
export const PILOT_EXIT = { ok: 0, failed: 1, refused: 2, dryRun: 3, stopped: 4 } as const;

/** What the apply preview knows, handed to `PilotIo.beforeApply`. Counts and money only. */
export interface BeforeApplyInfo {
  /** The cell count the PROPOSAL printed (the sample; cells already in a resumed ledger included). */
  readonly cells: number;
  readonly model: string;
  /** Base estimate for the arm that will run; null when the model has no price. */
  readonly baseCostUsd: number | null;
  /** False when some cells could not be sized (the estimate is incomplete). */
  readonly baseComplete: boolean;
  /** Cell keys (hashes) of the cells this run would send to the model; for the paid-twice overlap check. */
  readonly cellKeys?: readonly string[] | undefined;
}

export interface PilotIo {
  loadCandidates(accountId: string): Promise<readonly T3Candidate[]>;
  /** `unknownStartDates` is the pilot's roster option (empty = none); it never reaches a model call. */
  loadRoster(options: { readonly unknownStartDates: readonly string[] }): Promise<RosterIndex>;
  /** Called only when text is needed: dry-run with --read-text, or apply. */
  makeReader(): DocumentReader;
  /** Called only in apply, by the stage, after every guard passed. */
  makeLlm(): Promise<LlmDriver>;
  /** Called only in apply. */
  makeSink(): T3Sink;
  /**
   * Optional caller guard (the `casting-run` orchestrator). Called only in apply, after the
   * PROPOSAL and every guard of this driver, before the ledger header is written and before any
   * model client exists. Throw a GuardError to refuse: nothing is started. Absent = no extra guard.
   */
  beforeApply?(info: BeforeApplyInfo): void | Promise<void>;
  /**
   * Optional observer (the unattended job's plan step): called with the same facts as
   * `beforeApply`, in dry-run and in apply, right after the PROPOSAL is printed. It cannot refuse.
   */
  onProposal?(info: BeforeApplyInfo): void;
  /** Opens (and creates) the JSONL ledger. Called only for an existing directory in dry-run. */
  openLedger(dir: string): Ledger;
  /** The checkout and the working directory: a ledger inside either is refused. */
  readonly repoRoots: readonly string[];
  print(line: string): void;
  readonly now?: Date | undefined;
}

// ---- ledger header and directory guard -------------------------------------------------

export function signatureOf(args: PilotArgs): Record<string, string | number> {
  return {
    accountId: args.accountId,
    windowStart: args.windowStart,
    variant: args.variant,
    sampleSize: args.sampleSize,
    seed: args.sampleSeed,
    promptVersion: T3_PROMPT_VERSION,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    capChars: PILOT_CAP_CHARS,
  };
}

export type LedgerDirState =
  | { readonly state: 'absent' | 'empty' }
  | { readonly state: 'resumable'; readonly header: LedgerHeader };

export function inspectLedgerDir(
  dir: string,
  signature: Readonly<Record<string, string | number>>,
): LedgerDirState {
  if (!fs.existsSync(dir)) return { state: 'absent' };
  if (!fs.statSync(dir).isDirectory()) throw new GuardError('the ledger path is not a directory');
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) return { state: 'empty' };
  const file = path.join(dir, PILOT_HEADER_FILE);
  if (!fs.existsSync(file)) {
    throw new GuardError(
      'the ledger directory is not empty and has no pilot header: use a new directory',
    );
  }
  let header: LedgerHeader;
  try {
    header = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerHeader;
  } catch {
    throw new GuardError('the ledger header is not readable JSON: use a new directory');
  }
  if (header.v !== 1 || !Array.isArray(header.sample?.fileIds)) {
    throw new GuardError('the ledger header has an unknown format: use a new directory');
  }
  const differs = Object.keys({ ...signature, ...header.signature }).filter(
    (k) => signature[k] !== header.signature[k],
  );
  if (differs.length > 0) {
    throw new GuardError(
      `the ledger belongs to another seed or configuration (differs: ${differs.join(', ')}): use a new directory`,
    );
  }
  return { state: 'resumable', header };
}

function writeHeader(dir: string, header: LedgerHeader): void {
  fs.mkdirSync(dir, { recursive: true });
  // 'wx': never overwrite an existing header.
  fs.writeFileSync(path.join(dir, PILOT_HEADER_FILE), JSON.stringify(header, null, 2) + '\n', {
    flag: 'wx',
  });
}

// ---- sizing recorder ---------------------------------------------------------------------

/** Wraps a reader and records the length of every document it returned. */
export class RecordingReader implements DocumentReader {
  readonly lengths: number[] = [];
  readonly skips: Record<string, number> = {};
  constructor(private readonly inner: DocumentReader) {}
  async read(c: T3Candidate): Promise<ReadOutcome> {
    const out = await this.inner.read(c);
    if (out.kind === 'ok') this.lengths.push(out.text.length);
    else this.skips[out.reason] = (this.skips[out.reason] ?? 0) + 1;
    return out;
  }
}

const unusedReader: DocumentReader = {
  async read() {
    throw new GuardError('this path must not read documents');
  },
};

const refusingSink: T3Sink = {
  async startRun() {
    throw new GuardError('dry-run must not touch a sink');
  },
  async writeEvidence() {
    throw new GuardError('dry-run must not touch a sink');
  },
  async finishRun() {
    throw new GuardError('dry-run must not touch a sink');
  },
};

const refusingLlm = async (): Promise<LlmDriver> => {
  throw new GuardError('dry-run must not create a model client');
};

// ---- reference estimate -----------------------------------------------------------------

/** The calibrated presets (pilot P1, thinking LOW), keyed for the dry-run print. */
export function referenceAssumptions(): Record<string, CostAssumptions> {
  const p = ASSUMPTION_PRESETS;
  return { low: p.low, base: p.base, high: p.high };
}

function lengthStats(lengths: readonly number[], cap: number): string {
  if (lengths.length === 0) return 'no documents read';
  const s = [...lengths].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const capped = s.reduce((a, b) => a + Math.min(b, cap), 0) / s.length;
  return `n=${s.length} mean=${Math.round(mean)} capped-mean=${Math.round(capped)} p50=${at(0.5)} p90=${at(0.9)} max=${s[s.length - 1]}`;
}

// ---- the run ---------------------------------------------------------------------------

function classCounts(
  pool: Readonly<Record<string, number>>,
  sample: Readonly<Record<string, number>>,
): string {
  return Object.keys(pool)
    .map((c) => `${c} ${sample[c] ?? 0}/${pool[c]}`)
    .join(', ');
}

function nonZero(rec: Readonly<Record<string, number>>): string {
  const parts = Object.entries(rec)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

export interface PilotOutcome {
  readonly exitCode: number;
  readonly sample: SampleResult;
  readonly selection: Selection;
  readonly preview: T3Report;
  readonly applied: T3Report | null;
  /** Set when `--incremental`: what the sibling ledgers already hold, and what is left to pay. */
  readonly incremental: IncrementalPlan | null;
}

export async function runPilot(args: PilotArgs, io: PilotIo): Promise<PilotOutcome> {
  const apply = args.mode === 'apply';
  const sig: CellConfigSignature = {
    promptVersion: T3_PROMPT_VERSION,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    capChars: PILOT_CAP_CHARS,
  };
  const signature = signatureOf(args);

  // Guard 1: the ledger directory is outside the repository and in a usable state.
  const dir = args.ledgerDir === null ? null : path.resolve(args.ledgerDir);
  let dirState: LedgerDirState = { state: 'absent' };
  if (dir !== null) {
    try {
      for (const root of io.repoRoots) assertOutsideRepo(dir, root);
    } catch (err) {
      throw new GuardError(err instanceof Error ? err.message : String(err));
    }
    dirState = inspectLedgerDir(dir, signature);
  }

  // Shortlist and sample.
  const candidates = await io.loadCandidates(args.accountId);
  const policy: SelectionPolicy = { windowStart: args.windowStart, variant: args.variant };
  const selection = selectCandidates(candidates, policy);
  // Incremental (S9): the pool is only what no sibling ledger has paid under this signature.
  let prior: PriorLedgers | null = null;
  let inc: IncrementalPlan | null = null;
  if (args.incremental && dir !== null) {
    prior = readPriorLedgers(dir, args.accountId, io.repoRoots[0] ?? process.cwd());
    inc = planIncremental(selection, sig, prior.records, { retryFailed: args.retryFailed });
  }
  const pool = inc ? inc.toPay : selection.selected;
  const keptById = new Map(pool.map((s) => [s.candidate.fileId, s]));
  let sample = stratifiedSample(
    pool.map((s) => ({ fileId: s.candidate.fileId, docClass: s.docClass })),
    args.sampleSize,
    args.sampleSeed,
  );
  let resumed = false;
  if (dirState.state === 'resumable') {
    // The header is the authority on resume: the same cells, whatever the listing says now.
    const ids = dirState.header.sample.fileIds;
    const missing = ids.filter((id) => !keptById.has(id));
    if (missing.length > 0) {
      throw new GuardError(
        `${missing.length} sampled cell(s) of the ledger header are no longer in the shortlist (the listing changed): use a new directory`,
      );
    }
    const byClass: Record<string, number> = {};
    for (const id of ids) {
      const c = (keptById.get(id) as { docClass: string }).docClass;
      byClass[c] = (byClass[c] ?? 0) + 1;
    }
    sample = { ...sample, fileIds: ids, sampleByClass: byClass };
    resumed = true;
  }

  // Guard 2: the selection must fit the approved cell count.
  if (apply) {
    const approval = args.approval as NonNullable<PilotArgs['approval']>;
    if (sample.fileIds.length > approval.maxCells) {
      throw new GuardError(
        `the selection has ${sample.fileIds.length} cells, above --max-cells ${approval.maxCells}; nothing was started`,
      );
    }
  }

  // The stage sees the sampled kept cells plus their copies (not cells, no model call).
  const stageCandidates: T3Candidate[] = [];
  for (const id of sample.fileIds) {
    const kept = keptById.get(id) as NonNullable<ReturnType<typeof keptById.get>>;
    stageCandidates.push(kept.candidate);
    for (const copy of selection.copiesOf.get(id) ?? []) stageCandidates.push(copy.candidate);
  }

  const roster = await io.loadRoster({ unknownStartDates: args.unknownStartDates });
  const needsText = apply || args.readText;
  const recorder = new RecordingReader(needsText ? io.makeReader() : unusedReader);
  // A dry-run never opens a ledger it would have to create; an existing one is read for the resume view.
  const ownLedger: Ledger =
    dir !== null && dirState.state === 'resumable' ? io.openLedger(dir) : new MemoryLedger();
  const ledger: Ledger = prior ? new ChainedLedger(prior.records, ownLedger) : ownLedger;

  const common = {
    policy,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    capChars: PILOT_CAP_CHARS,
    parallel: args.parallel,
    retryFailed: args.retryFailed,
    now: io.now,
  } as const;
  const deps = (over: Partial<T3Deps>): T3Deps => ({
    reader: recorder,
    ledger,
    sink: refusingSink,
    roster,
    llmFactory: refusingLlm,
    ...over,
  });

  // The preview is always a dry-run of the stage: it prices the sample and touches nothing.
  const preview = await runT3(
    {
      ...common,
      mode: 'dry-run',
      readText: !apply && args.readText,
      ...(apply ? { fallbackChars: PILOT_FALLBACK_CHARS } : {}),
    },
    deps({}),
    stageCandidates,
  );
  if (preview.plan.selected !== sample.fileIds.length) {
    throw new Error(
      `internal: the stage re-selected ${preview.plan.selected} cells from a sample of ${sample.fileIds.length}`,
    );
  }

  // Order matters: the PROPOSAL block comes first, details after it.
  const arms = [...preview.estimates].sort(
    (a, b) => Number(b.model === args.model) - Number(a.model === args.model),
  );
  io.print(
    formatProposal({
      cells: sample.fileIds.length,
      accounts: args.accountId,
      thinkingLevel: args.thinkingLevel,
      parallel: args.parallel,
      estimates: arms,
      copies: {
        documentsToRead: preview.plan.documentsToRead,
        expanded: preview.plan.copies.expandedForCellsToRun,
        withoutContext: preview.plan.copies.copy_without_context,
        overCap: preview.plan.copies.overCap,
        byAccountClass: preview.plan.copies.byAccountClass,
      },
    }),
  );
  io.print(`arm to run: ${args.model}   (any other arm above is a reference only)`);
  const armBase = preview.estimates.find((e) => e.model === args.model)?.base;
  const proposalInfo: BeforeApplyInfo = {
    cells: sample.fileIds.length,
    model: args.model,
    baseCostUsd: armBase ? armBase.costUsd : null,
    baseComplete: armBase ? armBase.complete : false,
    cellKeys: sample.fileIds.map((id) =>
      cellKeyOf((keptById.get(id) as { candidate: T3Candidate }).candidate, sig),
    ),
  };
  io.onProposal?.(proposalInfo);
  io.print('');
  io.print('PILOT DETAILS');
  io.print(
    `account: ${args.accountId}   window-start: ${args.windowStart}   variant: ${args.variant}   seed: ${args.sampleSeed}`,
  );
  if (inc && prior) {
    io.print(
      `incremental: ${prior.ledgers} earlier ledger(s) read (${inc.priorRecords} records); cells already paid ${inc.unchanged}; new files with paid content ${inc.paidContent}; copy lines to add (rows only, $0) ${inc.carries.length}; cells to pay ${inc.toPay.length}${inc.retried > 0 ? ` (retried failures ${inc.retried})` : ''}`,
    );
  }
  io.print(
    `shortlist (kept cells, one per content hash): ${sample.pool}   tiers A ${selection.tierCounts.A} / B ${selection.tierCounts.B} / C ${selection.tierCounts.C}`,
  );
  io.print(`excluded by the shortlist step: ${nonZero(selection.excluded)}`);
  io.print(
    `sample: ${sample.fileIds.length} of ${sample.pool} (requested ${args.sampleSize})${resumed ? '   [resumed: cells taken from the ledger header]' : ''}`,
  );
  io.print(
    `sample by class (sample/pool): ${classCounts(sample.poolByClass, sample.sampleByClass)}`,
  );
  io.print(
    `sink: none (ledger only; no database writes)   ledger dir: ${dir ?? '(not given)'}   state: ${dirState.state}`,
  );
  io.print(
    `already done in the ledger: ${preview.plan.cellsAlreadyDone}   to run: ${preview.plan.cellsToRun}`,
  );
  io.print(
    `sizing: ${apply ? `not read in the preview; unread cells priced at [ASSUME ${PILOT_FALLBACK_CHARS}] chars` : args.readText ? `documents read, ${preview.sizedCells} sized, ${preview.unsizedCells} unsized` : 'not read (--read-text off): estimate incomplete'}`,
  );
  if (!apply && args.readText) {
    io.print(`measured text length (chars): ${lengthStats(recorder.lengths, PILOT_CAP_CHARS)}`);
    io.print(`read skips: ${nonZero(recorder.skips)}`);
  }
  if (priceOf(args.model) !== null && (recorder.lengths.length > 0 || apply)) {
    const refs = referenceAssumptions();
    const cellChars = apply
      ? Array.from({ length: preview.plan.cellsToRun }, () => PILOT_FALLBACK_CHARS)
      : recorder.lengths;
    io.print(
      `reference estimate, presets calibrated: ${PRESETS_CALIBRATION} (thinking LOW; Flash Lite token use [ASSUME] = Flash); low / base / high:`,
    );
    for (const model of Object.keys(MODEL_PRICES)) {
      const cost = (k: string): string =>
        `$${(estimate(model, { cellChars }, refs[k] as CostAssumptions)?.costUsd ?? 0).toFixed(2)}`;
      io.print(`  ${model}: ${cost('low')} / ${cost('base')} / ${cost('high')}`);
    }
  }

  if (!apply) {
    io.print('dry-run: no run started, no sink touched, no model client created (exit 3)');
    return {
      exitCode: PILOT_EXIT.dryRun,
      sample,
      selection,
      preview,
      applied: null,
      incremental: inc,
    };
  }

  // ---- apply: every guard has passed; the caller's guard, then header, then the stage ----
  if (io.beforeApply) await io.beforeApply(proposalInfo);
  const approval = args.approval as NonNullable<PilotArgs['approval']>;
  const target = dir as string;
  // A quiet day: nothing to pay and no copy line to add. Nothing is created: no directory, no
  // header, no model client, no sink.
  if (
    inc &&
    dirState.state !== 'resumable' &&
    sample.fileIds.length === 0 &&
    inc.carries.length === 0
  ) {
    io.print(
      'incremental: nothing new since the earlier ledgers: no ledger written, no model call, $0',
    );
    return { exitCode: PILOT_EXIT.ok, sample, selection, preview, applied: null, incremental: inc };
  }
  if (dirState.state !== 'resumable') {
    const header: LedgerHeader = {
      v: 1,
      createdAt: (io.now ?? new Date()).toISOString(),
      signature,
      extractorVersion: extractorVersionOf(sig),
      sample: {
        seed: sample.seed,
        requested: sample.requested,
        pool: sample.pool,
        poolByClass: sample.poolByClass,
        sampleByClass: sample.sampleByClass,
        fileIds: sample.fileIds,
      },
    };
    writeHeader(target, header);
  }
  const openedLedger = io.openLedger(target);
  const applyLedger: Ledger = prior ? new ChainedLedger(prior.records, openedLedger) : openedLedger;
  if (inc) {
    // $0 copies of content an earlier ledger paid: lines only; the loader turns them into rows.
    const ownKeys = new Set(openedLedger.load().map((r) => r.cellKey));
    const at = (io.now ?? new Date()).toISOString();
    for (const c of inc.carries) {
      const key = copyCellKeyOf(c.keptCellKey, c.ref.fileId);
      if (ownKeys.has(key)) continue;
      applyLedger.append({
        v: 1,
        cellKey: key,
        extractorVersion: extractorVersionOf(sig),
        at,
        status: 'copy',
        reason: c.why === 'md5_paid' ? 'md5_copy_of_paid' : 'listing_copy_of_paid',
        copyOfCellKey: c.keptCellKey,
        candidate: {
          fileId: c.ref.fileId,
          accountId: c.ref.accountId,
          createdTime: c.ref.createdTime,
          projectRef: c.ref.projectRef,
        },
        docClass: c.ref.docClass,
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
    if (sample.fileIds.length === 0) {
      io.print(
        `incremental: ${inc.carries.length} copy line(s) written, no cell to pay: no model client created, $0`,
      );
      return {
        exitCode: PILOT_EXIT.ok,
        sample,
        selection,
        preview,
        applied: null,
        incremental: inc,
      };
    }
  }
  const applied = await runT3(
    { ...common, mode: 'apply', approval },
    deps({ ledger: applyLedger, sink: io.makeSink(), llmFactory: io.makeLlm }),
    stageCandidates,
  );
  const run = applied.run;
  if (run) {
    io.print('');
    io.print(
      `RUN ${run.status}: attempted ${run.attempted}, ok ${run.ok}, failed ${run.failed}, skipped ${run.skipped}, deferred ${run.deferred}   cost $${run.costUsd}   (ceiling $${approval.maxCostUsd})`,
    );
    io.print(
      `rows resolved in memory (not stored): ${run.rowsInserted}   copies expanded, $0: ${run.copies.expanded}`,
    );
  }
  const exitCode =
    run === null || run.status === 'failed'
      ? PILOT_EXIT.failed
      : run.status === 'stopped'
        ? PILOT_EXIT.stopped
        : PILOT_EXIT.ok;
  return { exitCode, sample, selection, preview, applied, incremental: inc };
}
