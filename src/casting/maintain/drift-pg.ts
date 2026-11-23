/**
 * Read-only Postgres reader of the drift monitor: aggregate counts over `evidence`,
 * `experience` and `experience_evidence_links` for one account. SELECT only, no names, quotes or
 * ids come back. Raw SQL like the other casting adapters (the casting tables are not in the
 * generated client of this repo's pinned schema package).
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DriftCounts } from './drift';

export type DriftClient = Pick<PrismaClient, '$queryRaw'>;

export class PgDriftReader {
  constructor(private readonly db: DriftClient) {}

  async read(args: {
    accountId: string;
    fusionVersion: string;
    windowCutoff: string | null;
  }): Promise<DriftCounts> {
    const { accountId, fusionVersion } = args;

    const kinds = await this.db.$queryRaw<{ person_kind: string; n: number }[]>(Prisma.sql`
      SELECT person_kind, count(*)::int AS n
        FROM evidence
       WHERE account_id = ${accountId}::uuid AND source = 'drive_content'
       GROUP BY person_kind`);
    const byKind = Object.fromEntries(kinds.map((r) => [r.person_kind, r.n]));

    const reasons = await this.db.$queryRaw<{ reason: string | null; n: number }[]>(Prisma.sql`
      SELECT withheld_reason AS reason, count(*)::int AS n
        FROM experience
       WHERE account_id = ${accountId}::uuid AND fusion_version = ${fusionVersion}
       GROUP BY withheld_reason`);
    const withheldByReason: Record<string, number> = {};
    let served = 0;
    let total = 0;
    for (const r of reasons) {
      total += r.n;
      if (r.reason === null) served += r.n;
      else withheldByReason[r.reason] = r.n;
    }

    const served2 = await this.db.$queryRaw<
      {
        multi: number;
        min: number | null;
        p10: number | null;
        p50: number | null;
        p90: number | null;
        max: number | null;
      }[]
    >(Prisma.sql`
      SELECT count(*) FILTER (WHERE t.tiers >= 2)::int AS multi,
             min(t.confidence)::float8 AS min,
             percentile_cont(0.1) WITHIN GROUP (ORDER BY t.confidence)::float8 AS p10,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY t.confidence)::float8 AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY t.confidence)::float8 AS p90,
             max(t.confidence)::float8 AS max
        FROM (
          SELECT x.id, x.confidence, count(DISTINCT e.source) AS tiers
            FROM experience x
            LEFT JOIN experience_evidence_links l ON l.experience_id = x.id
            LEFT JOIN evidence e ON e.id = l.evidence_id
           WHERE x.account_id = ${accountId}::uuid
             AND x.fusion_version = ${fusionVersion}
             AND x.withheld_reason IS NULL
           GROUP BY x.id, x.confidence
        ) t`);
    const s = served2[0];

    let servedBeforeCutoff: number | null = null;
    if (args.windowCutoff !== null) {
      const rows = await this.db.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT count(*)::int AS n
          FROM experience
         WHERE account_id = ${accountId}::uuid
           AND fusion_version = ${fusionVersion}
           AND withheld_reason IS NULL
           AND period_end IS NOT NULL
           AND period_end < ${args.windowCutoff}::date`);
      servedBeforeCutoff = rows[0]?.n ?? 0;
    }

    return {
      t3Rows: {
        staff: byKind['staff'] ?? 0,
        external_unresolved: byKind['external_unresolved'] ?? 0,
        quarantined: byKind['quarantined'] ?? 0,
      },
      experience: {
        total,
        served,
        withheldByReason,
        servedMultiTier: s?.multi ?? 0,
        confidence:
          served > 0 &&
          s &&
          s.min !== null &&
          s.p10 !== null &&
          s.p50 !== null &&
          s.p90 !== null &&
          s.max !== null
            ? { min: s.min, p10: s.p10, p50: s.p50, p90: s.p90, max: s.max }
            : null,
      },
      servedBeforeCutoff,
    };
  }
}
