/**
 * Standalone entry of the T2 stage (not wired into src/main.ts on purpose: the
 * v1 modes there stay untouched and parallel casting stages edit the same
 * switch). Run as a Cloud Run Job command override or locally:
 *
 *   node dist/src/casting/t2/main.js --account-id <uuid>            (dry-run)
 *   node dist/src/casting/t2/main.js --account-id <uuid> --apply    (writes evidence)
 *
 * Dry-run is the default and writes nothing. Apply needs the UB migration for
 * `evidence` applied first (see pg-adapters.ts). The report on stdout is counts
 * only: no names, emails, actor resources or file ids. No Drive, People or
 * model call is made by this stage.
 */
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { PgCatalogReader, PgEvidenceWriter, loadRoster } from '../t1/pg-adapters';
import { defaultWindowStart } from '../t1/args';
import { parseT2Args } from './args';
import { PgFileIndexLookup, PgPeopleMapReader, PgStatsReader, PgT2RunStore } from './pg-adapters';
import { buildT2Roster } from './roster';
import { runT2 } from './run';

async function main(argv: readonly string[]): Promise<number> {
  const args = parseT2Args(argv);
  const today = new Date();
  const envDomains = (process.env['CASTING_AGENCY_EMAIL_DOMAINS'] ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  const domains = [...new Set([...envDomains, ...args.agencyDomains])];
  if (domains.length === 0) {
    logger.warn(
      {},
      '[casting.t2] no agency email domains configured: an email outside the roster is not classified by domain',
    );
  }

  const roster = buildT2Roster(await loadRoster(prisma), {
    agencyDomains: domains,
    unknownStartDates: args.unknownStartDates,
  });
  const report = await runT2(
    {
      stats: new PgStatsReader(prisma),
      index: new PgFileIndexLookup(prisma),
      people: new PgPeopleMapReader(prisma),
      catalog: new PgCatalogReader(prisma),
      roster,
      ...(args.apply
        ? { writer: new PgEvidenceWriter(prisma), runs: new PgT2RunStore(prisma) }
        : {}),
      logger,
    },
    {
      accountIds: args.accountIds,
      apply: args.apply,
      chunkSize: args.chunkSize ?? undefined,
      today,
      windowStart: args.windowStart === undefined ? defaultWindowStart(today) : args.windowStart,
      budgetMs: args.budgetSeconds === null ? null : args.budgetSeconds * 1000,
      resumeRunId: args.resumeRunId,
      unknownStartDates: args.unknownStartDates,
    },
  );
  console.log(JSON.stringify({ msg: 'casting-t2 report', report }));
  return report.status === 'success' ? 0 : report.status === 'paused' ? 75 : 1;
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
          msg: 'casting-t2 fatal',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
