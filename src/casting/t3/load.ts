/**
 * The ledger loader's core: a finished T3 run ledger (`header.json` + `cells.jsonl`, written by
 * the pilot driver) to Layer 1 `evidence` rows, with NO model call.
 *
 * Hermetic like pilot.ts: it imports no config, Prisma, Drive or model client. The roster and the
 * sink arrive through `LoadIo`, wired by load-main.ts.
 *
 * Flow
 *   1. guards: the ledger directory is outside the repository and complete; the header's
 *      account is the one named on the command line; the header is internally consistent
 *      (its extractor version is the one its own signature produces) and was written under
 *      the CURRENT prompt version; every ok cell carries the header's extractor version and
 *      the account. Anything else refuses before the roster or the sink is touched.
 *   2. resolve: `resolveLedgerRecords`, the stage's own function (also used by `runT3`): the same
 *      row builder (`mentionsToDrafts`, `row.ts`) and the same identical-content copy
 *      expansion (`copies.ts`, driven by the `copy` lines the stage recorded in the ledger).
 *      Rows are stamped with the ledger record's own extractor version (never the code's).
 *   3. dry-run (default): print counts only (no names, no quotes), write nothing, exit 3.
 *   4. apply: every row is built and checked first; only then the sink is opened (a sync run
 *      row, then insert-or-ignore batches on UNIQUE(extractor_version, claim_hash)), so a
 *      resolve error leaves nothing behind and a second run inserts 0.
 *
 * The extractor-version rule, and why no `--allow-...` flag: the stage already stamps each row
 * with `rec.extractorVersion` at its resolve step, so a ledger of an older configuration would
 * load under ITS version tag and stay purgeable by that tag. What the loader still refuses is a
 * ledger whose mentions were produced under another PROMPT version than the code now running:
 * the sanitising and grounding that vetted those mentions are this code's, and a bumped prompt
 * or schema means they were vetted by different rules. Check out the commit of that version to
 * load such a ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RosterIndex } from '../identity';
import {
  assertOutsideRepo,
  extractorVersionOf,
  GuardError,
  JsonlLedger,
  PILOT_HEADER_FILE,
  type CellRecord,
  type LedgerHeader,
} from './ledger';
import type { LoadArgs } from './load-args';
import { runDay } from './period';
import { newResolveCounts, resolveLedgerRecords, type ResolveCounts } from './resolve-mentions';
import type { EvidenceRowShape } from './row';
import type { T3Sink } from './sink';
import { T3_PROMPT_VERSION } from './types';

/** Rows per insert; the same as the stage's write batch. */
export const LOAD_BATCH = 500;

/** Exit codes, as in the pilot driver: a dry-run exits 3 on purpose ("printed, nothing written"). */
export const LOAD_EXIT = { ok: 0, failed: 1, refused: 2, dryRun: 3 } as const;

export interface LoadIo {
  /** Reads the staff roster (existing tables only; works before the casting migration). */
  loadRoster(options: {
    readonly unknownStartDates: readonly string[];
    readonly agencyDomains: readonly string[];
  }): Promise<RosterIndex>;
  /** Called only in apply, after every guard passed and every row was built. */
  makeSink(): Promise<T3Sink>;
  /** The checkout and the working directory: a ledger inside either is refused. */
  readonly repoRoots: readonly string[];
  print(line: string): void;
}

export interface LoadedLedger {
  readonly header: LedgerHeader;
  /** The date of the pilot run (`header.createdAt`): the run date of the period clamp. */
  readonly runDate: Date;
  readonly records: readonly CellRecord[];
  /** Non-empty lines of cells.jsonl that did not parse as a v1 record (a torn last line). */
  readonly unreadableLines: number;
}

/** Reads and checks the ledger directory. Never creates anything. */
export function readLedgerDir(
  dir: string,
  repoRoots: readonly string[],
  accountId: string,
): LoadedLedger {
  let resolved = path.resolve(dir);
  try {
    for (const root of repoRoots) resolved = assertOutsideRepo(dir, root);
  } catch (err) {
    throw new GuardError(err instanceof Error ? err.message : String(err));
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new GuardError('the ledger directory does not exist');
  }
  const headerFile = path.join(resolved, PILOT_HEADER_FILE);
  const cellsFile = path.join(resolved, 'cells.jsonl');
  if (!fs.existsSync(headerFile)) throw new GuardError('the ledger directory has no header.json');
  if (!fs.existsSync(cellsFile)) throw new GuardError('the ledger directory has no cells.jsonl');

  let header: LedgerHeader;
  try {
    header = JSON.parse(fs.readFileSync(headerFile, 'utf8')) as LedgerHeader;
  } catch {
    throw new GuardError('the ledger header is not readable JSON');
  }
  const sig = header?.signature;
  if (
    header?.v !== 1 ||
    typeof header.extractorVersion !== 'string' ||
    sig === null ||
    typeof sig !== 'object'
  ) {
    throw new GuardError('the ledger header has an unknown format');
  }
  if (typeof sig['accountId'] !== 'string' || sig['accountId'].toLowerCase() !== accountId) {
    throw new GuardError(
      '--account-id is not the account this ledger was run for (header signature); nothing was read',
    );
  }
  // The clamp's run date is the pilot's, never today's: a load on another day must give the
  // same rows. No fallback: a header without a usable date is refused.
  const created = header.createdAt;
  if (
    typeof created !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(created) ||
    Number.isNaN(Date.parse(created))
  ) {
    throw new GuardError(
      'the ledger header has no usable createdAt (ISO date-time): the period clamp needs the date of the pilot run',
    );
  }
  const runDate = new Date(created);
  const fromSignature = extractorVersionOf({
    promptVersion: String(sig['promptVersion']),
    model: String(sig['model']),
    thinkingLevel: String(sig['thinkingLevel']),
    capChars: Number(sig['capChars']),
  });
  if (fromSignature !== header.extractorVersion) {
    throw new GuardError(
      `the ledger header is inconsistent: its extractor version ${header.extractorVersion} is not the one its signature gives (${fromSignature})`,
    );
  }
  if (sig['promptVersion'] !== T3_PROMPT_VERSION) {
    throw new GuardError(
      `the ledger was written under prompt version ${String(sig['promptVersion'])}, this code is ${T3_PROMPT_VERSION}: its mentions were vetted by other rules (check out the commit of that version to load it)`,
    );
  }

  const records = new JsonlLedger(resolved, repoRoots[0] ?? process.cwd()).load();
  const nonEmpty = fs
    .readFileSync(cellsFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '').length;

  const wrongVersion = records.filter(
    (r) => r.status === 'ok' && r.extractorVersion !== header.extractorVersion,
  ).length;
  if (wrongVersion > 0) {
    throw new GuardError(
      `${wrongVersion} ok cell(s) carry an extractor version other than the header's ${header.extractorVersion}: the ledger mixes configurations`,
    );
  }
  const foreign = records.filter(
    (r) =>
      (r.status === 'ok' || r.status === 'copy') &&
      r.candidate.accountId.toLowerCase() !== accountId,
  ).length;
  if (foreign > 0) {
    throw new GuardError(
      `${foreign} cell(s) of the ledger belong to another account than --account-id; nothing was read`,
    );
  }
  return { header, runDate, records, unreadableLines: nonEmpty - records.length };
}

export interface LoadReport {
  readonly extractorVersion: string;
  readonly runDay: string;
  readonly cellsByStatus: Readonly<Record<string, number>>;
  readonly unreadableLines: number;
  readonly okCells: number;
  readonly resolve: ResolveCounts;
  /** Rows built before the cross-cell duplicate collapse. */
  readonly rowsBuilt: number;
  /** The same claim in two ok cells (same extractor version and claim_hash): the first is kept. */
  readonly duplicatesAcrossCells: number;
  /** Rows that would be written: unique by (extractor_version, claim_hash). */
  readonly rows: readonly EvidenceRowShape[];
  readonly byKind: Readonly<Record<string, number>>;
  readonly byWithheldReason: Readonly<Record<string, number>>;
  readonly applied: {
    readonly syncRunId: string;
    readonly inserted: number;
    readonly alreadyPresent: number;
  } | null;
}

const bump = (rec: Record<string, number>, key: string): void => {
  rec[key] = (rec[key] ?? 0) + 1;
};

const sortedLine = (rec: Readonly<Record<string, number>>): string => {
  const parts = Object.keys(rec)
    .sort()
    .map((k) => `${k} ${rec[k]}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
};

export interface LoadOutcome {
  readonly exitCode: number;
  readonly report: LoadReport;
}

export async function runLoad(args: LoadArgs, io: LoadIo): Promise<LoadOutcome> {
  const apply = args.mode === 'apply';
  const accountId = args.accountId.toLowerCase();

  // Guards first: the roster and the sink are not touched before they pass.
  const { header, runDate, records, unreadableLines } = readLedgerDir(
    args.ledgerDir,
    io.repoRoots,
    accountId,
  );
  const cellsByStatus: Record<string, number> = {};
  for (const r of records) bump(cellsByStatus, r.status);
  const okCells = new Set(records.filter((r) => r.status === 'ok').map((r) => r.cellKey)).size;
  if (okCells === 0) throw new GuardError('the ledger has no ok cell: nothing to load');

  const now = runDate;
  const roster = await io.loadRoster({
    unknownStartDates: args.unknownStartDates,
    agencyDomains: args.agencyDomains,
  });
  const counts = newResolveCounts();
  const drafts = resolveLedgerRecords(
    records,
    // The ledger's own `copy` lines carry the kept -> copies mapping: no selection edges here.
    { roster, now, selectionEdges: [], selectedKeys: null },
    counts,
  );

  const seen = new Set<string>();
  const rows: EvidenceRowShape[] = [];
  let duplicatesAcrossCells = 0;
  for (const { row } of drafts) {
    const key = `${row.extractor_version}|${row.claim_hash}`;
    if (seen.has(key)) {
      duplicatesAcrossCells++;
      continue;
    }
    seen.add(key);
    rows.push(row);
  }
  const byKind: Record<string, number> = {};
  const byWithheldReason: Record<string, number> = {};
  for (const r of rows) {
    bump(byKind, r.person_kind);
    bump(byWithheldReason, r.withheld_reason ?? 'none');
  }

  const base = {
    extractorVersion: header.extractorVersion,
    runDay: runDay(now),
    cellsByStatus,
    unreadableLines,
    okCells,
    resolve: counts,
    rowsBuilt: drafts.length,
    duplicatesAcrossCells,
    rows,
    byKind,
    byWithheldReason,
  };

  const print = (line: string): void => io.print(line);
  print(`LEDGER LOAD (${apply ? 'apply' : 'dry-run'})`);
  print(`account: ${accountId}   extractor version: ${header.extractorVersion}`);
  print(
    `ledger cells: ${sortedLine(cellsByStatus)}   unreadable lines: ${unreadableLines}   ok cells: ${okCells}`,
  );
  print(`run date (period clamp, from the ledger header): ${base.runDay}`);
  print(
    `mentions resolved: ${counts.mentions}   duplicate claims inside a document: ${counts.duplicateClaims}`,
  );
  print(
    `copies (identical content, $0): expanded ${counts.copies.expanded} (rows ${counts.copies.rows}), without context ${counts.copies.copy_without_context}, over cap ${counts.copies.overCap}`,
  );
  print(
    `rows built: ${drafts.length}   duplicates by claim_hash across cells: ${duplicatesAcrossCells}   rows to write: ${rows.length}`,
  );
  print(`rows by person_kind: ${sortedLine(byKind)}`);
  print(`rows by withheld_reason: ${sortedLine(byWithheldReason)}`);
  print(`resolver reasons: ${sortedLine(counts.byReason)}`);

  if (!apply) {
    print('dry-run: nothing written, no sink opened, no model call (exit 3)');
    return { exitCode: LOAD_EXIT.dryRun, report: { ...base, applied: null } };
  }

  if (rows.length === 0) {
    print('apply: no rows to write, no sync run created');
    return { exitCode: LOAD_EXIT.ok, report: { ...base, applied: null } };
  }

  // Apply: every row is built and checked; only now does the sink open (it may refuse, see
  // SinkUnavailableError: before the migration nothing is created).
  const sink = await io.makeSink();
  const { syncRunId } = await sink.startRun({
    extractorVersion: header.extractorVersion,
    details: {
      mode: 'ledger_load',
      account_id: accountId,
      // The window cutoff the ledger was selected under (S9: recorded in every run report).
      window_start:
        typeof header.signature['windowStart'] === 'string'
          ? header.signature['windowStart']
          : null,
      ok_cells: okCells,
      rows_to_write: rows.length,
      copies_expanded: counts.copies.expanded,
      rows_by_person_kind: byKind,
      rows_by_withheld_reason: byWithheldReason,
      duplicates_across_cells: duplicatesAcrossCells,
    },
  });
  let inserted = 0;
  let alreadyPresent = 0;
  try {
    for (let i = 0; i < rows.length; i += LOAD_BATCH) {
      const w = await sink.writeEvidence(syncRunId, rows.slice(i, i + LOAD_BATCH));
      inserted += w.inserted;
      alreadyPresent += w.duplicates;
    }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    try {
      await sink.finishRun(syncRunId, {
        status: 'failed',
        summary: { cells: okCells, rows: inserted, costUsd: 0 },
        details: { rows_inserted: inserted, rows_already_present: alreadyPresent, error: message },
      });
    } catch {
      // the original error is the one to show
    }
    throw err;
  }
  await sink.finishRun(syncRunId, {
    status: 'success',
    summary: { cells: okCells, rows: inserted, costUsd: 0 },
    details: { rows_inserted: inserted, rows_already_present: alreadyPresent },
  });
  print(`sync run ${syncRunId}: success`);
  print(
    `evidence rows: inserted ${inserted}, already present ${alreadyPresent} (of ${rows.length})`,
  );
  return {
    exitCode: LOAD_EXIT.ok,
    report: { ...base, applied: { syncRunId, inserted, alreadyPresent } },
  };
}
