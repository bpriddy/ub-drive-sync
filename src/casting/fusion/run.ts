/**
 * Fusion stage driver: reads Layer 1 of each account, fuses it, and (only with
 * `apply`) replaces that account's Layer 2 output in one transaction.
 *
 * Dry-run is the default and writes nothing: no rows, no `sync_runs` row. It
 * still READS `evidence`, so it needs the UB migration too: before it, both modes
 * fail with Postgres 42P01 (relation "evidence" does not exist), on purpose.
 *
 * Accounts are fused one at a time (projects never cross accounts), which bounds
 * memory to one account's Layer 1. [MEASURE: rows per account on the real drive.]
 * The report carries counts only: no names, quotes, paths or file ids.
 */
import { FUSION_VERSION } from './constants';
import { fuse } from './fuse';
import type {
  ActivityHorizon,
  CatalogLoader,
  EvidenceReader,
  ExperienceWriter,
  FusionEvidence,
  FusionMetrics,
  FusionRunStore,
  RunCounts,
  StaffLoader,
  WriteCounts,
} from './types';

export const DEFAULT_CHUNK_SIZE = 5000;

export interface FusionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface FusionDeps {
  evidence: EvidenceReader;
  catalog: CatalogLoader;
  staff: StaffLoader;
  /** Optional: without it the T2-agreement proxy is empty. */
  activity?: ActivityHorizon | undefined;
  /** Required in apply mode. */
  writer?: ExperienceWriter | undefined;
  /** Required in apply mode. */
  runs?: FusionRunStore | undefined;
  logger?: FusionLogger | undefined;
}

export interface FusionOptions {
  accountIds: readonly string[];
  apply: boolean;
  /** The run date. The only clock the stage sees; it decides who is "current". */
  today: Date;
  chunkSize?: number | undefined;
}

export interface FusionAccountReport {
  accountId: string;
  metrics: FusionMetrics;
  /** null in dry-run. */
  written: WriteCounts | null;
}

export interface FusionReport {
  mode: 'dry-run' | 'apply';
  fusionVersion: string;
  /** YYYY-MM-DD */
  today: string;
  runId: string | null;
  status: 'success' | 'failed';
  accounts: FusionAccountReport[];
}

const errorText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function runFusion(deps: FusionDeps, options: FusionOptions): Promise<FusionReport> {
  const chunk = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunk) || chunk < 1)
    throw new RangeError('chunkSize must be a positive integer');
  const apply = options.apply;
  if (apply && (!deps.writer || !deps.runs)) {
    throw new Error('apply mode needs an experience writer and a run store');
  }
  const today = options.today.toISOString().slice(0, 10);
  const accounts: FusionAccountReport[] = [];
  const counts: RunCounts = { evidenceRows: 0, deleted: 0, inserted: 0, links: 0 };

  let runId: string | null = null;
  if (apply) {
    runId = await (deps.runs as FusionRunStore).open({
      stage: 'casting_fusion',
      fusion_version: FUSION_VERSION,
      accounts: options.accountIds.length,
      today,
    });
  }

  try {
    const staff = await deps.staff.load(today);
    for (const accountId of [...options.accountIds].sort()) {
      const evidence: FusionEvidence[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await deps.evidence.readPage(accountId, after, chunk);
        evidence.push(...page);
        if (page.length < chunk) break;
        after = (page[page.length - 1] as FusionEvidence).id;
      }
      const catalog = await deps.catalog.load(accountId);
      const horizon = deps.activity === undefined ? null : await deps.activity.startOf(accountId);
      const out = fuse({
        evidence,
        accounts: catalog.account === null ? [] : [catalog.account],
        campaigns: catalog.campaigns,
        pieces: catalog.pieces,
        staff,
        activityStartByAccount: new Map([[accountId, horizon]]),
      });

      let written: WriteCounts | null = null;
      if (apply) {
        written = await (deps.writer as ExperienceWriter).replaceAccount({
          accountId,
          fusionVersion: FUSION_VERSION,
          syncRunId: runId as string,
          claims: out.claims,
        });
        counts.deleted += written.deleted;
        counts.inserted += written.inserted;
        counts.links += written.links;
      }
      counts.evidenceRows += evidence.length;
      accounts.push({ accountId, metrics: out.metrics, written });
      deps.logger?.info(
        {
          accountId,
          mode: apply ? 'apply' : 'dry-run',
          evidenceRows: evidence.length,
          stored: out.metrics.claims.stored,
          served: out.metrics.claims.served,
        },
        '[casting.fusion] account finished',
      );
    }
  } catch (err) {
    if (apply) {
      await (deps.runs as FusionRunStore)
        .finish(runId as string, 'failed', counts, `failed: ${errorText(err)}`)
        .catch((e: unknown) =>
          deps.logger?.warn({ err: errorText(e) }, '[casting.fusion] could not mark run failed'),
        );
    }
    throw err;
  }

  if (apply) {
    await (deps.runs as FusionRunStore).finish(
      runId as string,
      'success',
      counts,
      `success: evidence=${counts.evidenceRows} deleted=${counts.deleted} inserted=${counts.inserted} links=${counts.links}`,
    );
  }
  return {
    mode: apply ? 'apply' : 'dry-run',
    fusionVersion: FUSION_VERSION,
    today,
    runId,
    status: 'success',
    accounts,
  };
}
