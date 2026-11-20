/**
 * Entry point of the ledger loader: a finished T3 run ledger to Layer 1 `evidence` rows, no model
 * call. The only file that wires the roster and the Postgres sink, each through a lazy import that
 * runs only on the path that needs it:
 *
 *   node dist/src/casting/t3/load-main.js --ledger-dir /abs/path --account-id UUID \
 *        [--agency-domain agency.example ...] [--unknown-start-date YYYY-MM-DD ...]
 *                                                  (dry-run, the default: counts only, exit 3)
 *   ... --apply                                    (writes: needs the UB casting migration)
 *
 * No model client, no Drive and no document reader is reachable from here (a test walks the
 * import closure). See docs/casting-t3-pilot.md, "Loading a ledger into Layer 1".
 */
import path from 'node:path';
import { GuardError } from './ledger';
import { parseLoadArgs } from './load-args';
import { LOAD_EXIT, runLoad, type LoadIo } from './load';
import { SinkUnavailableError } from './sink';

/** The production wiring. Nothing here touches the database until called. */
export function realLoadIo(): LoadIo {
  return {
    loadRoster: async (options) => (await import('./real-pilot-io')).loadRosterIndex(options),
    makeSink: async () => {
      const { prisma } = await import('../../prisma');
      const { PgT3Sink } = await import('./pg-sink');
      return new PgT3Sink(prisma);
    },
    repoRoots: [process.cwd(), path.resolve(__dirname, '..', '..', '..')],
    print: (line) => console.log(line),
  };
}

export async function runLoadCli(argv: readonly string[], io: LoadIo): Promise<number> {
  try {
    const args = parseLoadArgs(argv);
    return (await runLoad(args, io)).exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const refused =
      err instanceof GuardError ||
      err instanceof SinkUnavailableError ||
      /^--|unknown flag|unexpected argument/.test(msg);
    console.error(`${refused ? 'REFUSED' : 'ERROR'}: ${msg}`);
    return refused ? LOAD_EXIT.refused : LOAD_EXIT.failed;
  }
}

if (require.main === module) {
  runLoadCli(process.argv.slice(2), realLoadIo())
    .then(async (code) => {
      try {
        await (await import('./real-pilot-io')).closeRealIo();
      } catch {
        // nothing was connected
      }
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(LOAD_EXIT.failed);
    });
}
