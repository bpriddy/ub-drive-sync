/**
 * Where the stage writes in apply mode: a sync run row and Layer 1 rows.
 *
 * An interface, so the stage core never touches a database. The real writer is
 * `PgT3Sink` (pg-sink.ts: raw SQL, insert-or-ignore on the table's
 * UNIQUE(extractor_version, claim_hash), plus a `sync_runs` row); only the ledger
 * loader (load-main.ts) wires it. `MemorySink` is the fake the tests use.
 */
import type { EvidenceRowShape } from './row';

/**
 * The sink cannot take writes (for example the `evidence` table does not exist yet: the UB
 * migration is not applied). Thrown by `startRun` BEFORE anything is written; the message is
 * safe to show as is.
 */
export class SinkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SinkUnavailableError';
  }
}

export interface RunSummaryForSink {
  readonly cells: number;
  readonly rows: number;
  readonly costUsd: number;
}

export interface T3Sink {
  startRun(info: {
    extractorVersion: string;
    /** Extra facts for the run record (`sync_runs.details`). Counts and ids only, no names. */
    details?: Readonly<Record<string, unknown>>;
  }): Promise<{ syncRunId: string }>;
  /** Insert-or-ignore on (extractor_version, claim_hash). */
  writeEvidence(
    syncRunId: string,
    rows: readonly EvidenceRowShape[],
  ): Promise<{ inserted: number; duplicates: number }>;
  finishRun(
    syncRunId: string,
    outcome: {
      status: 'success' | 'failed' | 'stopped';
      summary: RunSummaryForSink;
      /** Merged into the run record's details. Counts and ids only, no names. */
      details?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void>;
}

export class MemorySink implements T3Sink {
  readonly rows = new Map<string, EvidenceRowShape & { sync_run_id: string }>();
  readonly runs: { syncRunId: string; status: string | null; summary: RunSummaryForSink | null }[] =
    [];

  async startRun(): Promise<{ syncRunId: string }> {
    const syncRunId = `run-${this.runs.length + 1}`;
    this.runs.push({ syncRunId, status: null, summary: null });
    return { syncRunId };
  }

  async writeEvidence(
    syncRunId: string,
    rows: readonly EvidenceRowShape[],
  ): Promise<{ inserted: number; duplicates: number }> {
    let inserted = 0;
    let duplicates = 0;
    for (const r of rows) {
      const key = `${r.extractor_version}|${r.claim_hash}`;
      if (this.rows.has(key)) duplicates++;
      else {
        this.rows.set(key, { ...r, sync_run_id: syncRunId });
        inserted++;
      }
    }
    return { inserted, duplicates };
  }

  async finishRun(
    syncRunId: string,
    outcome: { status: 'success' | 'failed' | 'stopped'; summary: RunSummaryForSink },
  ): Promise<void> {
    const run = this.runs.find((r) => r.syncRunId === syncRunId);
    if (run) {
      run.status = outcome.status;
      run.summary = outcome.summary;
    }
  }
}
