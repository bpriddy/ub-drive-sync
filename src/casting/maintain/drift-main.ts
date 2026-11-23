/**
 * Drift report of one account (S9 task 3). READ ONLY: SELECTs over evidence / experience, one
 * JSON line of counts and rates on stdout, nothing written anywhere.
 *
 *   node dist/src/casting/maintain/drift-main.js --account-id UUID
 *        [--fusion-version fusion-v3]    the Layer 2 version to read (default: this code's)
 *        [--window-start YYYY-MM-DD]     also count served claims that ended before this cutoff
 *        [--compare /path/previous.json] a previous report (the JSON this command printed)
 *        [--fail-on-breach]              exit 6 when a threshold is crossed (default exit 0)
 *
 * The thresholds are placeholders (constants.ts, TODO S8): a breach is a prompt to look, not a
 * verdict. Exit codes: 0 ok, 1 error, 2 refused (bad arguments), 6 breach with --fail-on-breach.
 */
import fs from 'node:fs';
import { FUSION_VERSION } from '../fusion/constants';
import { DRIFT_EXIT_BREACH, DRIFT_THRESHOLDS } from './constants';
import { computeDrift, evaluateDrift, type DriftCounts, type DriftReport } from './drift';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface DriftArgs {
  readonly accountId: string;
  readonly fusionVersion: string;
  readonly windowCutoff: string | null;
  readonly compare: string | null;
  readonly failOnBreach: boolean;
}

export function parseDriftArgs(argv: readonly string[]): DriftArgs {
  const values = new Map<string, string>();
  let failOnBreach = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--fail-on-breach') {
      failOnBreach = true;
      continue;
    }
    if (!['--account-id', '--fusion-version', '--window-start', '--compare'].includes(a)) {
      throw new Error(`unknown argument ${a}`);
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    if (values.has(a)) throw new Error(`${a} given twice`);
    values.set(a, v);
  }
  const accountId = values.get('--account-id');
  if (accountId === undefined || !UUID.test(accountId))
    throw new Error('--account-id UUID is required');
  const cutoff = values.get('--window-start') ?? null;
  if (cutoff !== null && (!ISO.test(cutoff) || Number.isNaN(Date.parse(cutoff)))) {
    throw new Error('--window-start must be YYYY-MM-DD');
  }
  return {
    accountId: accountId.toLowerCase(),
    fusionVersion: values.get('--fusion-version') ?? FUSION_VERSION,
    windowCutoff: cutoff,
    compare: values.get('--compare') ?? null,
    failOnBreach,
  };
}

export interface DriftIo {
  read(args: {
    accountId: string;
    fusionVersion: string;
    windowCutoff: string | null;
  }): Promise<DriftCounts>;
  readPrevious(path: string): DriftReport;
  print(line: string): void;
}

export async function runDrift(args: DriftArgs, io: DriftIo): Promise<number> {
  const counts = await io.read(args);
  const report = computeDrift(counts, {
    fusionVersion: args.fusionVersion,
    windowCutoff: args.windowCutoff,
  });
  const previous = args.compare === null ? null : io.readPrevious(args.compare);
  const verdict = evaluateDrift(report, previous);
  io.print(
    JSON.stringify({
      msg: 'casting-drift report',
      report,
      breaches: verdict.breaches,
      notJudged: verdict.notJudged,
      thresholds: DRIFT_THRESHOLDS,
      thresholdsRatifiedByS8: false,
    }),
  );
  return args.failOnBreach && verdict.breaches.length > 0 ? DRIFT_EXIT_BREACH : 0;
}

/** Accepts the report itself or the whole line this command printed. */
export function readPreviousReport(path: string): DriftReport {
  const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as {
    report?: DriftReport;
  } & Partial<DriftReport>;
  const report = parsed.report ?? (parsed as DriftReport);
  if (typeof report.servedCount !== 'number') throw new Error('--compare: not a drift report');
  return report;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: DriftArgs;
  try {
    args = parseDriftArgs(argv);
  } catch (err) {
    console.error(`REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { prisma } = await import('../../prisma');
  const { PgDriftReader } = await import('./drift-pg');
  try {
    return await runDrift(args, {
      read: (a) => new PgDriftReader(prisma).read(a),
      readPrevious: readPreviousReport,
      print: (l) => console.log(l),
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
