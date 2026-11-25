/**
 * Standalone entry of the fusion stage (not wired into src/main.ts on purpose,
 * like the T1 / T2 / T3 entries). Pattern A job: no HTTP. Run as a Cloud Run Job
 * command override or locally:
 *
 *   node dist/src/casting/fusion/main.js --account-id <uuid>            (dry-run)
 *   node dist/src/casting/fusion/main.js --account-id <uuid> --apply    (rebuilds the account's staff work rows)
 *
 * Dry-run is the default and writes nothing. Both modes need the UB migrations for
 * `evidence` (and apply for the staff work tables, 20261124200000_staff_work)
 * applied first: before them they fail with Postgres 42P01. No model is called. The report on stdout is counts only.
 */
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { parseFusionArgs } from './args';
import {
  PgActivityHorizon,
  PgCatalogLoader,
  PgEvidenceReader,
  PgFusionRunStore,
  PgStaffLoader,
  PgStaffWorkWriter,
} from './pg-adapters';
import { runFusion } from './run';

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseFusionArgs(argv);
  const report = await runFusion(
    {
      evidence: new PgEvidenceReader(prisma),
      catalog: new PgCatalogLoader(prisma),
      staff: new PgStaffLoader(prisma, args.unknownStartDates),
      activity: new PgActivityHorizon(prisma),
      ...(args.apply
        ? { writer: new PgStaffWorkWriter(prisma), runs: new PgFusionRunStore(prisma) }
        : {}),
      logger,
    },
    {
      accountIds: args.accountIds,
      apply: args.apply,
      chunkSize: args.chunkSize ?? undefined,
      today: new Date(),
    },
  );
  console.log(JSON.stringify({ msg: 'casting-fusion report', report }));
  return report.status === 'success' ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(async (code) => {
      await prisma.$disconnect();
      process.exit(code);
    })
    .catch(async (err: unknown) => {
      console.error(
        JSON.stringify({
          msg: 'casting-fusion fatal',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
