/**
 * Command line of the pilot driver (pilot-main.ts). It wraps the stage's own flags
 * (parseT3Args: dry-run default, `--apply` needs `--max-cells`, `--max-usd` and
 * `--ledger-dir`; none of that is loosened here) and adds the pilot's own:
 *
 *   --account-id UUID       the one account of the pilot
 *   --sample-size N         cells to draw from the kept shortlist (default 120)
 *   --sample-seed STRING    required; recorded in the ledger header
 *
 * Unknown flags are errors: a mistyped `--max-cell` must not silently mean "no limit".
 */
import path from 'node:path';
import { parseT3Args, type T3Args } from './args';

export const PILOT_DEFAULT_SAMPLE_SIZE = 120;

export interface PilotArgs extends T3Args {
  readonly accountId: string;
  readonly sampleSize: number;
  readonly sampleSeed: string;
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  '--account-id',
  '--sample-size',
  '--sample-seed',
  '--window-start',
  '--variant',
  '--model',
  '--thinking',
  '--parallel',
  '--read-text',
  '--retry-failed',
  '--apply',
  '--max-cells',
  '--max-usd',
  '--ledger-dir',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePilotArgs(argv: readonly string[]): PilotArgs {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    if (!KNOWN_FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a, next);
      i++;
    } else flags.set(a, true);
  }
  const value = (k: string): string | undefined => {
    const v = flags.get(k);
    if (v === true) throw new Error(`${k} needs a value`);
    return v;
  };

  const base = parseT3Args(argv);

  const accountId = value('--account-id');
  if (accountId === undefined || !UUID.test(accountId)) {
    throw new Error('--account-id UUID is required');
  }
  const sizeRaw = value('--sample-size');
  const sampleSize = sizeRaw === undefined ? PILOT_DEFAULT_SAMPLE_SIZE : Number(sizeRaw);
  if (!Number.isInteger(sampleSize) || sampleSize < 1) {
    throw new Error('--sample-size must be an integer >= 1');
  }
  const sampleSeed = value('--sample-seed');
  if (sampleSeed === undefined || sampleSeed.trim() === '') {
    throw new Error('--sample-seed STRING is required');
  }
  if (base.mode === 'apply') {
    if (base.ledgerDir === null || !path.isAbsolute(base.ledgerDir)) {
      throw new Error('--ledger-dir must be an absolute path');
    }
    const approval = base.approval as NonNullable<T3Args['approval']>;
    if (approval.maxCells < sampleSize) {
      throw new Error(
        `--max-cells ${approval.maxCells} is below the sample size ${sampleSize}; nothing was started`,
      );
    }
  }
  return { ...base, accountId, sampleSize, sampleSeed };
}
