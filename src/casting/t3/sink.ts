/**
 * Where the stage writes in apply mode: a sync run row and Layer 1 rows.
 *
 * An interface, so the stage core never touches a database. The real writer
 * (a Prisma `evidence.createMany({ skipDuplicates })` keyed by the table's
 * UNIQUE(extractor_version, claim_hash), plus a `sync_runs` row, in the
 * hr-sheet-sync pattern) needs the gub-schemas 1.23.0 client and is added
 * after that version is pinned. `MemorySink` is the fake the tests use.
 */
import type { EvidenceRowShape } from './row';

export interface RunSummaryForSink {
  readonly cells: number;
  readonly rows: number;
  readonly costUsd: number;
}

export interface T3Sink {
  startRun(info: { extractorVersion: string }): Promise<{ syncRunId: string }>;
  /** Insert-or-ignore on (extractor_version, claim_hash). */
  writeEvidence(
    syncRunId: string,
    rows: readonly EvidenceRowShape[],
  ): Promise<{ inserted: number; duplicates: number }>;
  finishRun(
    syncRunId: string,
    outcome: { status: 'success' | 'failed' | 'stopped'; summary: RunSummaryForSink },
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
