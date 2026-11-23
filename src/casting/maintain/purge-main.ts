/**
 * Entry of the purge (S9 task 4). DRY-RUN BY DEFAULT.
 *
 *   node dist/src/casting/maintain/purge-main.js --account-id UUID --extractor-version t3-v1:gemini-3.5-flash:low
 *   ... --apply --expect-rows N      (deletes; N is the count the dry-run printed)
 *
 * Exit codes: 0 ok, 1 error, 2 refused, 3 dry-run printed. See docs/casting-pipeline.md ("Purge").
 */
import { parsePurgeArgs, PURGE_EXIT, runPurge } from './purge';

export async function main(argv: readonly string[]): Promise<number> {
  let args;
  try {
    args = parsePurgeArgs(argv);
  } catch (err) {
    console.error(`REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    return PURGE_EXIT.refused;
  }
  const { prisma } = await import('../../prisma');
  const { PgPurgeStore } = await import('./purge-pg');
  try {
    return await runPurge(args, new PgPurgeStore(prisma), (l) => console.log(l));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(PURGE_EXIT.failed);
    });
}
