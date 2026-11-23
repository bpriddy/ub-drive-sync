/**
 * Entry point of `casting-run`: the whole casting chain for ONE account, with guards.
 *
 *   node dist/src/casting/run-all/main.js --account-id UUID --window-start 2021-11-20 \
 *        --sample-size N --sample-seed S                     (PLAN, the default: exit 3)
 *   ... --apply                                              (free writes: t1, t2, load, fusion)
 *   ... --apply-t3 --max-cells N --max-usd X --ledger-dir /abs --expect-cells N
 *                                                            (PAID: needs an explicit go)
 *
 * See docs/casting-pipeline.md. The core (run.ts) is hermetic; the real stages are wired in
 * real-stages.ts.
 */
import path from 'node:path';
import { parseCastingArgs } from './args';
import { EXIT, runCasting, type RunDeps } from './run';
import { realStages } from './real-stages';

export function realDeps(): RunDeps {
  return {
    stages: realStages(),
    out: (line) => console.log(line),
    env: process.env,
    repoRoots: [process.cwd(), path.resolve(__dirname, '..', '..', '..')],
    now: () => new Date(),
    // Incremental apply only; the probe is read-only and imports Prisma lazily.
    changeProbe: async (accountId) => {
      const { prisma } = await import('../../prisma');
      return (await import('../maintain/change-probe')).probeChanges(prisma, accountId);
    },
    applyAgencyDomains: (csv) => {
      // One roster option set for every stage: the pilot reads the domains from the env only.
      if (csv !== '') process.env['CASTING_AGENCY_EMAIL_DOMAINS'] = csv;
    },
  };
}

export async function runCastingCli(
  argv: readonly string[],
  deps: RunDeps,
  printError: (line: string) => void = (l) => console.error(l),
): Promise<number> {
  let args;
  try {
    args = parseCastingArgs(argv, deps.now());
  } catch (err) {
    printError(`REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.refused;
  }
  return (await runCasting(args, deps)).exitCode;
}

if (require.main === module) {
  runCastingCli(process.argv.slice(2), realDeps())
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
      process.exit(EXIT.failed);
    });
}
