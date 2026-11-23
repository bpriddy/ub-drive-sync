/**
 * Purge of one bad extractor version for one account (S9 task 4). DRY-RUN BY DEFAULT.
 *
 * What it deletes: the Layer 1 `evidence` rows of ONE `extractor_version` of ONE account. Nothing
 * else: not Layer 2 (rebuild it afterwards), not other versions, not other accounts, no ledger.
 * Links from Layer 2 to the deleted rows cascade (the table's own rule), which leaves Layer 2
 * rows with fewer sources until the rebuild.
 *
 * Guards: `--apply` is required to write; `--apply` also needs `--expect-rows N`, equal to the
 * count the dry-run printed (the rows you looked at are the rows deleted; a changed count
 * refuses); the version must look like a stage version (`t1-`, `t2-`, `t3-`...); every apply is
 * recorded as a `sync_runs` row (source `casting_purge`, counts and the version only).
 *
 * Hermetic core: the store is injected (purge-pg.ts is the Postgres one).
 */

export const PURGE_SYNC_SOURCE = 'casting_purge';
export const PURGE_BATCH = 5000;
export const PURGE_EXIT = { ok: 0, failed: 1, refused: 2, dryRun: 3 } as const;

/** A stage version: `t1-metadata-v2`, `t2-activity-v1`, `t3-v1:gemini-3.5-flash:low`. */
const VERSION = /^t[123]-[A-Za-z0-9._:-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PurgeArgs {
  readonly accountId: string;
  readonly extractorVersion: string;
  readonly apply: boolean;
  readonly expectRows: number | null;
}

export function parsePurgeArgs(argv: readonly string[]): PurgeArgs {
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--apply') {
      apply = true;
      continue;
    }
    if (!['--account-id', '--extractor-version', '--expect-rows'].includes(a)) {
      throw new Error(`unknown argument ${a}`);
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    if (values.has(a)) throw new Error(`${a} given twice`);
    values.set(a, v);
  }
  const accountId = values.get('--account-id');
  if (accountId === undefined || !UUID.test(accountId))
    throw new Error('--account-id UUID is required');
  const version = values.get('--extractor-version');
  if (version === undefined || !VERSION.test(version)) {
    throw new Error(
      '--extractor-version must be one exact stage version, e.g. t3-v1:gemini-3.5-flash:low',
    );
  }
  let expectRows: number | null = null;
  if (values.has('--expect-rows')) {
    expectRows = Number(values.get('--expect-rows'));
    if (!Number.isInteger(expectRows) || expectRows < 1)
      throw new Error('--expect-rows must be an integer >= 1');
  }
  if (apply && expectRows === null) {
    throw new Error(
      '--apply needs --expect-rows N (the count the dry-run printed); nothing was deleted',
    );
  }
  if (!apply && expectRows !== null)
    throw new Error('--expect-rows only means something with --apply');
  return { accountId: accountId.toLowerCase(), extractorVersion: version, apply, expectRows };
}

export interface PurgeCount {
  readonly rows: number;
  /** Rows per writing `sync_runs` row, largest first (at most 20 runs). */
  readonly bySyncRun: readonly { readonly syncRunId: string; readonly rows: number }[];
  readonly syncRuns: number;
}

export interface PurgeStore {
  count(accountId: string, extractorVersion: string): Promise<PurgeCount>;
  startRun(details: Readonly<Record<string, unknown>>): Promise<string>;
  /** Deletes up to `limit` rows of the account and version; returns how many went. */
  deleteBatch(accountId: string, extractorVersion: string, limit: number): Promise<number>;
  finishRun(
    runId: string,
    status: 'success' | 'failed',
    deleted: number,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

export async function runPurge(
  args: PurgeArgs,
  store: PurgeStore,
  print: (line: string) => void,
): Promise<number> {
  const count = await store.count(args.accountId, args.extractorVersion);
  print(
    `PURGE (${args.apply ? 'apply' : 'dry-run'})   extractor version: ${args.extractorVersion}`,
  );
  print(
    `evidence rows of this version for the account: ${count.rows}   written by ${count.syncRuns} sync run(s)`,
  );
  for (const r of count.bySyncRun) print(`  sync run ${r.syncRunId}: ${r.rows} rows`);

  if (count.rows === 0) {
    print('nothing to purge: no row of this version for this account');
    return PURGE_EXIT.ok;
  }
  if (!args.apply) {
    print('dry-run: nothing deleted. To delete: re-run with --apply --expect-rows ' + count.rows);
    print(
      'then rebuild Layer 2 for the account (fusion --apply) and keep the bad ledger out of any load',
    );
    return PURGE_EXIT.dryRun;
  }
  if (count.rows !== args.expectRows) {
    print(
      `REFUSED: ${count.rows} rows match but --expect-rows is ${args.expectRows}; nothing was deleted`,
    );
    return PURGE_EXIT.refused;
  }

  const base = {
    stage: PURGE_SYNC_SOURCE,
    account_id: args.accountId,
    extractor_version: args.extractorVersion,
    rows_expected: count.rows,
    sync_runs_affected: count.syncRuns,
  };
  const runId = await store.startRun(base);
  let deleted = 0;
  try {
    for (;;) {
      const n = await store.deleteBatch(args.accountId, args.extractorVersion, PURGE_BATCH);
      deleted += n;
      if (n < PURGE_BATCH) break;
    }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await store
      .finishRun(runId, 'failed', deleted, { ...base, rows_deleted: deleted, error: message })
      .catch(() => undefined);
    throw err;
  }
  await store.finishRun(runId, 'success', deleted, { ...base, rows_deleted: deleted });
  print(`sync run ${runId}: success, deleted ${deleted} rows`);
  print(
    'NEXT: rebuild Layer 2 for this account (fusion --apply); until then its rows show fewer sources',
  );
  return PURGE_EXIT.ok;
}
