/**
 * Fail-closed guards of `casting-run`. Every function throws a GuardError (the stages' own
 * "refused, nothing started" error, exit 2) or returns normally. No config, Prisma, logger or
 * model code here: the environment and the process-liveness probe are passed in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FUSION_VERSION } from '../fusion/constants';
import { assertOutsideRepo, GuardError, PILOT_HEADER_FILE } from '../t3/ledger';
import { signatureOf, type BeforeApplyInfo } from '../t3/pilot';
import type { PilotArgs } from '../t3/pilot-args';
import { priceOf } from '../t3/pricing';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The paid stage needs the priced surface: GEMINI_USE_ENTERPRISE explicitly 'true' (stricter than
 * the config default) and a GCP project. An API-key-only environment is refused. Without this the
 * model client silently becomes a mock driver.
 */
export function checkModelEnv(env: Env): void {
  const problems: string[] = [];
  if (env['GEMINI_USE_ENTERPRISE'] !== 'true') problems.push('GEMINI_USE_ENTERPRISE=true');
  if ((env['GCP_PROJECT_ID'] ?? '').trim() === '') problems.push('GCP_PROJECT_ID');
  if (problems.length > 0) {
    throw new GuardError(
      `the paid stage needs ${problems.join(' and ')} (an API-key-only environment is refused); nothing was started`,
    );
  }
}

export function checkModelPriced(model: string): void {
  if (priceOf(model) === null) {
    throw new GuardError(`model ${model} has no price in the pricing table; nothing was started`);
  }
}

export function checkLedgerOutside(dir: string, repoRoots: readonly string[]): string {
  let resolved = path.resolve(dir);
  try {
    for (const root of repoRoots) resolved = assertOutsideRepo(dir, root);
  } catch (err) {
    throw new GuardError(err instanceof Error ? err.message : String(err));
  }
  return resolved;
}

/** `<ledger-dir>` siblings are other ledgers; the lock and the run log live next to it, not in it. */
export const lockPathOf = (dir: string): string => `${path.resolve(dir)}.lock`;
export const runLogPathOf = (dir: string): string => `${path.resolve(dir)}.run-log.jsonl`;

const SAME_FIELDS = [
  'accountId',
  'windowStart',
  'promptVersion',
  'model',
  'thinkingLevel',
  'capChars',
] as const;

/** True when the file has an ok cell; with `keys`, an ok cell whose key is in the set. */
function hasOkCell(file: string, keys?: ReadonlySet<string>): boolean {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const rec = JSON.parse(line) as { status?: string; cellKey?: string };
      if (rec.status === 'ok' && (keys === undefined || keys.has(rec.cellKey ?? ''))) return true;
    } catch {
      // a torn line is not a paid cell
    }
  }
  return false;
}

/**
 * A second ledger over the same account and configuration means a second payment for the same
 * files (the loader dedupes only afterwards). Returns the name of the first sibling directory
 * whose header has the same account, window start, prompt version, model, thinking level and cap
 * AND at least one ok cell; null when none. The directory itself (a resume) is not a sibling.
 *
 * `overlapWith` (incremental runs): only a sibling with an ok cell whose key is in the set is a
 * twin; the signature fields are not compared (the cell key already covers them).
 */
export function findPaidTwice(
  dir: string,
  pilot: PilotArgs,
  options: { readonly overlapWith?: ReadonlySet<string> } = {},
): string | null {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) return null;
  const mine = signatureOf(pilot);
  for (const name of fs.readdirSync(parent).sort()) {
    const other = path.join(parent, name);
    if (other === resolved) continue;
    let header: { signature?: Record<string, unknown> };
    try {
      if (!fs.statSync(other).isDirectory()) continue;
      const file = path.join(other, PILOT_HEADER_FILE);
      if (!fs.existsSync(file)) continue;
      header = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof header;
    } catch {
      continue;
    }
    const sig = header.signature;
    if (!sig) continue;
    if (options.overlapWith !== undefined) {
      // Incremental run (S9): each day's ledger holds different cells by design, so a matching
      // configuration is not a twin. A twin is a sibling that already paid one of THESE cells
      // (the cell key carries file, content version, prompt, model, thinking and cap).
      if (
        String(sig['accountId']).toLowerCase() === String(mine['accountId']).toLowerCase() &&
        hasOkCell(path.join(other, 'cells.jsonl'), options.overlapWith)
      ) {
        return name;
      }
      continue;
    }
    if (
      SAME_FIELDS.every((k) => sig[k] === mine[k]) &&
      hasOkCell(path.join(other, 'cells.jsonl'))
    ) {
      return name;
    }
  }
  return null;
}

export const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * `<ledger-dir>.lock`, created with `wx`. A lock whose pid is dead is stale and replaced once.
 * Returns the release function.
 */
export function acquireLock(
  dir: string,
  now: Date,
  isPidAlive: (pid: number) => boolean = defaultPidAlive,
): () => void {
  const file = lockPathOf(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }) + '\n';
  const release = (): void => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let pid = NaN;
      try {
        pid = (JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number }).pid;
      } catch {
        // an unreadable lock cannot name a live pid: stale
      }
      if (Number.isInteger(pid) && isPidAlive(pid)) {
        throw new GuardError(`another casting-run holds ${file} (pid ${pid}); nothing was started`);
      }
      if (attempt === 0) release();
    }
  }
  throw new GuardError(`could not take the lock ${file}; nothing was started`);
}

/**
 * The orchestrator's hook for `PilotIo.beforeApply`: the PROPOSAL the person saw must be the run
 * that starts, and a run that cannot finish under the cap is refused rather than stopped half-way.
 */
export function checkBeforeApply(
  info: BeforeApplyInfo,
  limits: { readonly expectCells: number; readonly maxUsd: number },
): void {
  if (info.cells !== limits.expectCells) {
    throw new GuardError(
      `the PROPOSAL has ${info.cells} cells but --expect-cells is ${limits.expectCells} (the listing changed or the flags differ); nothing was started`,
    );
  }
  if (info.baseCostUsd === null) {
    throw new GuardError(`model ${info.model} has no price; nothing was started`);
  }
  if (info.baseCostUsd > limits.maxUsd) {
    throw new GuardError(
      `the base estimate $${info.baseCostUsd} is above --max-usd ${limits.maxUsd}: the run would stop at the ceiling; nothing was started`,
    );
  }
}

/**
 * A build version pin that differs from the code's version means serving is empty
 * after an apply. UB serves one `build_version` of the staff work tables
 * (`STAFF_WORK_BUILD_VERSION`, D44); fusion --apply replaces the account's rows
 * with this code's version.
 */
export function fusionPinReminder(env: Env): string | null {
  const pin = (env['STAFF_WORK_BUILD_VERSION'] ?? '').trim();
  if (pin === '' || pin === FUSION_VERSION) return null;
  return `STAFF_WORK_BUILD_VERSION is ${pin} but this code builds ${FUSION_VERSION}: after fusion --apply the served answer for the account is empty until the pin is switched`;
}
