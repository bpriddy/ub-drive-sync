/**
 * The T3 sink on Postgres: one `sync_runs` row per run (D3) and Layer 1 `evidence` rows.
 *
 * Raw SQL for the evidence insert, shared with T1 and T2 (`PgEvidenceWriter`): the `evidence`
 * table exists only after the UB casting migration (gub-schemas 1.23.0) and the generated Prisma
 * client of this repo's pinned package does not know the model. `sync_runs` is an existing table,
 * so it goes through the client's `syncRun` model, as in T1 and T2.
 *
 * BEFORE THE MIGRATION: `startRun` first probes the table (`SELECT 1 FROM evidence LIMIT 0`).
 * A missing table (Postgres 42P01) becomes a `SinkUnavailableError` with a plain message, and
 * NO `sync_runs` row is created: a refused load leaves no trace. (Creating the run first and
 * marking it failed would leave one failed row per attempt in the audit table for nothing.)
 *
 * Writes are batched by the caller; a batch is one multi-row INSERT with
 * `ON CONFLICT (extractor_version, claim_hash) DO NOTHING`, so a re-run inserts nothing twice.
 * A failure after some batches leaves those batches in place (the run row ends `failed` with the
 * counts so far); running the same load again completes it.
 *
 * Nothing here is exercised against a real database by the unit tests: they check the SQL shape
 * and parameters with a fake client.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { PgEvidenceWriter } from '../t1/pg-adapters';
import type { EvidenceInsertRow } from '../t1/types';
import type { EvidenceRowShape } from './row';
import { SinkUnavailableError, type RunSummaryForSink, type T3Sink } from './sink';
import { T3_SYNC_SOURCE } from './types';

export type T3DbClient = Pick<PrismaClient, '$queryRaw' | '$executeRaw' | 'syncRun'>;

/** True for Postgres 42P01 (undefined_table), however the driver wraps it. */
export function isUndefinedTable(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
    message?: unknown;
  } | null;
  if (e === null || typeof e !== 'object') return false;
  if (e.code === '42P01' || e.meta?.code === '42P01') return true;
  const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.meta?.message === 'string' ? e.meta.message : ''}`;
  return /\b42P01\b/.test(text) || /relation "evidence" does not exist/i.test(text);
}

const MISSING_TABLE_MESSAGE =
  'the evidence table does not exist in this database (Postgres 42P01): apply the UB casting migration (gub-schemas 1.23.0) first. Nothing was written';

function toInsertRow(r: EvidenceRowShape, syncRunId: string): EvidenceInsertRow {
  return {
    staffId: r.staff_id,
    rawName: r.raw_name,
    personKind: r.person_kind,
    accountId: r.account_id,
    jobNumber: r.job_number,
    campaignId: r.campaign_id,
    pieceId: r.piece_id,
    roleRaw: r.role_raw,
    roleNorm: r.role_norm,
    seniority: r.seniority,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    source: r.source,
    fileId: r.file_id,
    location: r.location,
    quote: r.quote,
    confidence: r.confidence,
    withheldReason: r.withheld_reason,
    extractorVersion: r.extractor_version,
    syncRunId,
    claimHash: r.claim_hash,
  };
}

interface RunState {
  readonly base: Record<string, unknown>;
  readonly startedAt: number;
  inserted: number;
  duplicates: number;
}

export class PgT3Sink implements T3Sink {
  private readonly writer: PgEvidenceWriter;
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly db: T3DbClient) {
    this.writer = new PgEvidenceWriter(db);
  }

  async startRun(info: {
    extractorVersion: string;
    details?: Readonly<Record<string, unknown>>;
  }): Promise<{ syncRunId: string }> {
    try {
      await this.db.$queryRaw(Prisma.sql`SELECT 1 AS ok FROM evidence LIMIT 0`);
    } catch (err) {
      if (isUndefinedTable(err)) throw new SinkUnavailableError(MISSING_TABLE_MESSAGE);
      throw err;
    }
    const base = {
      ...(info.details ?? {}),
      stage: 'casting_t3',
      extractor_version: info.extractorVersion,
    };
    const run = await this.db.syncRun.create({
      data: { source: T3_SYNC_SOURCE, status: 'running', details: base as Prisma.InputJsonValue },
      select: { id: true },
    });
    this.runs.set(run.id, { base, startedAt: Date.now(), inserted: 0, duplicates: 0 });
    return { syncRunId: run.id };
  }

  async writeEvidence(
    syncRunId: string,
    rows: readonly EvidenceRowShape[],
  ): Promise<{ inserted: number; duplicates: number }> {
    const state = this.runs.get(syncRunId);
    if (state === undefined) throw new Error(`sync run ${syncRunId} was not started by this sink`);
    let inserted: number;
    try {
      ({ inserted } = await this.writer.insertBatch(rows.map((r) => toInsertRow(r, syncRunId))));
    } catch (err) {
      if (isUndefinedTable(err)) throw new SinkUnavailableError(MISSING_TABLE_MESSAGE);
      throw err;
    }
    const duplicates = rows.length - inserted;
    state.inserted += inserted;
    state.duplicates += duplicates;
    return { inserted, duplicates };
  }

  async finishRun(
    syncRunId: string,
    outcome: {
      status: 'success' | 'failed' | 'stopped';
      summary: RunSummaryForSink;
      details?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    const state = this.runs.get(syncRunId);
    const status = outcome.status === 'success' ? 'success' : 'failed';
    await this.db.syncRun.update({
      where: { id: syncRunId },
      data: {
        status,
        summary: `casting_t3: ${outcome.status}; cells ${outcome.summary.cells}, rows inserted ${state?.inserted ?? outcome.summary.rows}, already present ${state?.duplicates ?? 0}`,
        completedAt: new Date(),
        durationMs: state ? Date.now() - state.startedAt : null,
        totalScanned: outcome.summary.cells,
        created: state?.inserted ?? outcome.summary.rows,
        skipped: state?.duplicates ?? 0,
        details: {
          ...(state?.base ?? {}),
          ...(outcome.details ?? {}),
          outcome: outcome.status,
        } as Prisma.InputJsonValue,
      },
    });
  }
}
