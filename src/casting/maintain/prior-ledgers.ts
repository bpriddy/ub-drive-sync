/**
 * Prior T3 ledgers of one account: the "what was already paid" record of the incremental run.
 *
 * A daily incremental run writes its own small ledger directory next to the earlier ones
 * (`<base>/<account>/<day>`). The earlier directories are siblings of the new one. This module
 * reads them, read-only (it creates nothing), and `ChainedLedger` presents them to the stage as
 * one ledger: the stage's own done-set and read-time copy logic then work across days with no
 * change to the stage, while every write goes to the new directory only.
 *
 * Hermetic: node:fs and node:path only; no config, Prisma, Drive or model code.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  GuardError,
  JsonlLedger,
  PILOT_HEADER_FILE,
  type CellRecord,
  type Ledger,
} from '../t3/ledger';

export interface PriorLedgers {
  /** Records of every sibling ledger of the same account, oldest directory name first. */
  readonly records: readonly CellRecord[];
  /** Sibling directories read. */
  readonly ledgers: number;
  /** Sibling directories skipped because they belong to another account or have no usable header. */
  readonly skipped: number;
}

/**
 * Every sibling directory of `ledgerDir` whose header names `accountId`. Other accounts are
 * never read: a sibling of another account is skipped, not an error. A sibling that has a header
 * but cannot be read is a GuardError, never a silent skip (an unread ledger would be paid again).
 * The directory itself is not a sibling: its own records reach the stage through the ledger it
 * opens.
 */
export function readPriorLedgers(
  ledgerDir: string,
  accountId: string,
  repoRoot: string,
): PriorLedgers {
  const resolved = path.resolve(ledgerDir);
  const parent = path.dirname(resolved);
  const records: CellRecord[] = [];
  let ledgers = 0;
  let skipped = 0;
  if (!fs.existsSync(parent)) return { records, ledgers, skipped };
  for (const name of fs.readdirSync(parent).sort()) {
    const dir = path.join(parent, name);
    if (dir === resolved) continue;
    // Not a ledger (a file, a lock, a run log, a directory with no header): not our business.
    let header: string;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      header = path.join(dir, PILOT_HEADER_FILE);
      if (!fs.existsSync(header)) continue;
    } catch {
      continue;
    }
    // A directory WITH a header is a ledger. If it cannot be read, what it paid is unknown, and
    // guessing "nothing" would pay for those cells again: fail closed.
    let parsed: { v?: number; signature?: { accountId?: unknown } };
    try {
      parsed = JSON.parse(fs.readFileSync(header, 'utf8')) as typeof parsed;
    } catch {
      throw new GuardError(
        `the earlier ledger ${name} has an unreadable header: refusing to guess what it paid; fix it or move it aside`,
      );
    }
    const acct = parsed.signature?.accountId;
    if (parsed.v !== 1 || typeof acct !== 'string') {
      throw new GuardError(
        `the earlier ledger ${name} has an unknown header format: refusing to guess what it paid; fix it or move it aside`,
      );
    }
    if (acct.toLowerCase() !== accountId.toLowerCase()) {
      skipped++;
      continue;
    }
    try {
      records.push(...new JsonlLedger(dir, repoRoot).load());
    } catch (err) {
      throw new GuardError(err instanceof Error ? err.message : String(err));
    }
    ledgers++;
  }
  return { records, ledgers, skipped };
}

/** Marks a kept cell copied into a newer ledger so that its copies can be loaded there. */
export const CARRIED_REASON = 'carried_from_prior_ledger';

/**
 * Prior records (read-only) in front of the run's own ledger. `load()` returns both, so the
 * stage sees every cell paid on earlier days. `append()` writes to the own ledger only. A `copy`
 * line whose kept cell lives in a prior ledger first gets a carried clone of that kept cell in
 * the own ledger (no usage, so no cost is counted twice): the loader resolves a ledger on its
 * own and needs the kept cell next to its copies. Re-resolving the carried cell yields claims
 * that already exist (same claim hash), which the insert-or-ignore write skips.
 */
export class ChainedLedger implements Ledger {
  private readonly priorByKey = new Map<string, CellRecord>();

  constructor(
    private readonly prior: readonly CellRecord[],
    private readonly own: Ledger,
  ) {
    for (const r of prior) if (r.status === 'ok') this.priorByKey.set(r.cellKey, r);
  }

  load(): readonly CellRecord[] {
    return [...this.prior, ...this.own.load()];
  }

  append(rec: CellRecord): void {
    if (rec.status === 'copy' && rec.copyOfCellKey !== undefined) {
      const key = rec.copyOfCellKey;
      const kept = this.priorByKey.get(key);
      if (kept !== undefined && !this.own.load().some((r) => r.cellKey === key)) {
        this.own.append({ ...kept, usage: null, reason: CARRIED_REASON, at: rec.at });
      }
    }
    this.own.append(rec);
  }
}
