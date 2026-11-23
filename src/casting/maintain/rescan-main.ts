/**
 * Entry of the re-scan plan (S9 task 2). PLAN ONLY, always exit 3 when a plan was printed:
 *
 *   node dist/src/casting/maintain/rescan-main.js --account-id UUID --window-start 2021-11-23 \
 *        --model gemini-3.5-flash --thinking LOW --ledger-dir /abs/ledgers/<account>/<new-day>
 *
 * It lists the account's Drive tree (read-only), reads the earlier ledgers next to
 * `--ledger-dir`, and prints how many cells the target extractor version would need and what
 * they would cost. No flag starts a paid run; the model client is not importable from here.
 */
import path from 'node:path';
import { parseRescanArgs, RESCAN_EXIT, runRescanPlan } from './rescan-plan';

export async function main(argv: readonly string[]): Promise<number> {
  let args;
  try {
    args = parseRescanArgs(argv);
  } catch (err) {
    console.error(`REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    return RESCAN_EXIT.refused;
  }
  await runRescanPlan(args, {
    loadCandidates: async (accountId) =>
      (await import('../t3/real-pilot-io')).loadAccountCandidates(accountId),
    repoRoot: path.resolve(__dirname, '..', '..', '..'),
    print: (l) => console.log(l),
  });
  return RESCAN_EXIT.planned;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(async (code) => {
      try {
        await (await import('../t3/real-pilot-io')).closeRealIo();
      } catch {
        // nothing was connected
      }
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RESCAN_EXIT.failed);
    });
}
