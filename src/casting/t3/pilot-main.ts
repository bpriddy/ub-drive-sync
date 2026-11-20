/**
 * Entry point of the pilot driver (P1). The only file that wires the real model client,
 * the real reader and the live listing for a pilot, each through a lazy import that runs
 * only on the path that needs it:
 *
 *   node dist/src/casting/t3/pilot-main.js --account-id UUID --window-start 2021-11-19 \
 *        --sample-size 120 --sample-seed STRING --model gemini-3.5-flash --thinking LOW \
 *        --parallel 2 --read-text                       (dry-run, the default: exit 3)
 *   ... --apply --max-cells 120 --max-usd 6.00 --ledger-dir /abs/path    (PAID: needs an explicit go)
 *
 * The model client is created only by `makeLlm`, which only the stage's apply path calls,
 * after every guard passed. See docs/casting-t3-pilot.md.
 */
import path from 'node:path';
import { MemorySink } from './sink';
import { JsonlLedger } from './ledger';
import { GuardError, PILOT_EXIT, runPilot, type PilotIo } from './pilot';
import { parsePilotArgs } from './pilot-args';
import type { DocumentReader, T3Candidate } from './types';

/** The production wiring. Nothing here touches a model, Drive or the database until called. */
export function realIo(): PilotIo {
  const repoRoots = [process.cwd(), path.resolve(__dirname, '..', '..', '..')];
  const reader: DocumentReader = {
    async read(c: T3Candidate) {
      const { createRealReader } = await import('./real-reader');
      return createRealReader().read(c);
    },
  };
  return {
    loadCandidates: async (accountId) =>
      (await import('./real-pilot-io')).loadAccountCandidates(accountId),
    loadRoster: async (options) => (await import('./real-pilot-io')).loadRosterIndex(options),
    makeReader: () => reader,
    makeLlm: async () => (await import('./real-llm')).createRealLlm(),
    makeSink: () => new MemorySink(),
    openLedger: (dir) => new JsonlLedger(dir, repoRoots[0]),
    repoRoots,
    print: (line) => console.log(line),
  };
}

export async function runPilotCli(argv: readonly string[], io: PilotIo): Promise<number> {
  try {
    const args = parsePilotArgs(argv);
    const out = await runPilot(args, io);
    return out.exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const refused = err instanceof GuardError || /^--|unknown flag|unexpected argument/.test(msg);
    console.error(`${refused ? 'REFUSED' : 'ERROR'}: ${msg}`);
    return refused ? PILOT_EXIT.refused : PILOT_EXIT.failed;
  }
}

if (require.main === module) {
  runPilotCli(process.argv.slice(2), realIo())
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
      process.exit(PILOT_EXIT.failed);
    });
}
