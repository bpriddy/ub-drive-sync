/**
 * Strict argument parsing for the fusion stage. Unknown flags and flags missing
 * a value are errors: a typo must never turn into a run on the wrong scope.
 *
 *   --account-id <uuid>          repeatable, at least one (no implicit "all accounts")
 *   --apply                      write Layer 2 (default: dry-run, nothing written)
 *   --chunk-size <n>             Layer 1 rows per page (default 5000)
 *   --unknown-start-date <date>  repeatable; a staff.started_at value that is an import
 *                                placeholder, not a hire date (the window check is skipped)
 */
export interface FusionArgs {
  accountIds: string[];
  apply: boolean;
  chunkSize: number | null;
  unknownStartDates: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseFusionArgs(args: readonly string[]): FusionArgs {
  const out: FusionArgs = { accountIds: [], apply: false, chunkSize: null, unknownStartDates: [] };
  const known = ['--account-id', '--chunk-size', '--unknown-start-date'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--apply') {
      out.apply = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!known.includes(flag)) throw new Error(`casting-fusion: unknown argument ${arg}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`casting-fusion: ${flag} needs a value`);
    switch (flag) {
      case '--account-id':
        if (!UUID.test(value)) throw new Error('casting-fusion: --account-id must be a uuid');
        if (!out.accountIds.includes(value)) out.accountIds.push(value);
        break;
      case '--chunk-size': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 20_000) {
          throw new Error('casting-fusion: --chunk-size must be an integer from 1 to 20000');
        }
        out.chunkSize = n;
        break;
      }
      case '--unknown-start-date':
        if (!ISO.test(value) || Number.isNaN(Date.parse(value))) {
          throw new Error('casting-fusion: --unknown-start-date must be YYYY-MM-DD');
        }
        out.unknownStartDates.push(value);
        break;
    }
  }
  if (out.accountIds.length === 0) {
    throw new Error('casting-fusion: at least one --account-id is required');
  }
  return out;
}
