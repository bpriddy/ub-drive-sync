/**
 * Standalone entry of the Activity edit-stats backfill (an ops step, not part
 * of the T2 evidence stage, and not wired into src/main.ts). Dry-run by default:
 *
 *   node dist/src/casting/t2/backfill/main.js --account-id <uuid> --from YYYY-MM-DD --to YYYY-MM-DD
 *   ... --confirm            fetch Drive Activity and write drive_edit_stats
 *
 * Dry-run reads the existing edit-stats run ids (overlap check) and the
 * account's Drive root, prints the windows and the call estimate, and makes no
 * Drive, People or model call. Exit codes: 0 done, 75 paused (budget), 1 failure
 * or overlap refusal. The report on stdout is counts only.
 */
import { prisma } from '../../../prisma';
import { logger } from '../../../logger';
import { PgPeopleMapReader } from '../pg-adapters';
import { parseBackfillArgs } from './args';
import { PgAccountReader, PgBackfillRunStore, PgExistingStatsReader } from './pg-adapters';
import { createRealActivitySource, createRealStatsWriter } from './real-ports';
import { OverlapError } from './overlap';
import { runBackfill } from './run';

async function main(argv: readonly string[]): Promise<number> {
  const args = parseBackfillArgs(argv);
  try {
    const report = await runBackfill(
      {
        existing: new PgExistingStatsReader(prisma),
        accounts: new PgAccountReader(prisma),
        ...(args.confirm
          ? {
              activity: createRealActivitySource(),
              writer: createRealStatsWriter(),
              people: new PgPeopleMapReader(prisma),
              runs: new PgBackfillRunStore(prisma),
            }
          : {}),
        logger,
      },
      {
        accountId: args.accountId,
        from: args.from,
        to: args.to,
        windowDays: args.windowDays,
        confirm: args.confirm,
        today: new Date(),
        existingWindowDays: args.existingWindowDays ?? undefined,
        budgetMs: args.budgetSeconds === null ? null : args.budgetSeconds * 1000,
        maxCalls: args.maxCalls,
        resumeRunId: args.resumeRunId,
      },
    );
    console.log(JSON.stringify({ msg: 'casting-t2 backfill report', report }));
    return report.status === 'success' ? 0 : 75;
  } catch (err) {
    if (err instanceof OverlapError) {
      console.error(
        JSON.stringify({
          msg: 'casting-t2 backfill refused',
          error: err.message,
          overlap: err.detail,
        }),
      );
      return 1;
    }
    throw err;
  }
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
          msg: 'casting-t2 backfill fatal',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
