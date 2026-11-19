/**
 * Standalone entry of the T1 stage (not wired into src/main.ts on purpose: the
 * v1 modes there stay untouched and parallel casting stages edit the same
 * switch). Run as a Cloud Run Job command override or locally:
 *
 *   node dist/src/casting/t1/main.js --account-id <uuid>            (dry-run)
 *   node dist/src/casting/t1/main.js --account-id <uuid> --apply    (writes evidence)
 *
 * Dry-run is the default and writes nothing. Apply needs the UB migration for
 * `evidence` applied first (see pg-adapters.ts). The report on stdout is counts
 * only: no names, paths, emails or file ids.
 */
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { buildRosterIndex } from '../identity';
import { defaultWindowStart, parseT1Args } from './args';
import {
  PgCatalogReader,
  PgEvidenceWriter,
  PgIndexReader,
  PgRunStore,
  loadRoster,
} from './pg-adapters';
import { runT1 } from './run';

async function main(argv: readonly string[]): Promise<number> {
  const args = parseT1Args(argv);
  const today = new Date();
  const envDomains = (process.env['CASTING_AGENCY_EMAIL_DOMAINS'] ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  const domains = [...new Set([...envDomains, ...args.agencyDomains])];
  if (domains.length === 0) {
    logger.warn(
      {},
      '[casting.t1] no agency email domains configured: an email outside the roster is not classified by domain',
    );
  }

  const roster = buildRosterIndex(await loadRoster(prisma), { agencyEmailDomains: domains });
  const report = await runT1(
    {
      index: new PgIndexReader(prisma),
      catalog: new PgCatalogReader(prisma),
      roster,
      ...(args.apply ? { writer: new PgEvidenceWriter(prisma), runs: new PgRunStore(prisma) } : {}),
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
      knownPrefixes: args.knownPrefixes,
    },
  );
  console.log(JSON.stringify({ msg: 'casting-t1 report', report }));
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
          msg: 'casting-t1 fatal',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
