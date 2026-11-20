/**
 * Command line of the ledger loader (load-main.ts). Dry-run is the default: nothing is written
 * without `--apply`.
 *
 *   --ledger-dir ABS_PATH      required; the pilot's run ledger (header.json + cells.jsonl)
 *   --account-id UUID          required; must equal the account the ledger was run for
 *   --agency-domain DOMAIN     repeatable; added to CASTING_AGENCY_EMAIL_DOMAINS (roster e-mail rule)
 *   --unknown-start-date D     repeatable (YYYY-MM-DD); same meaning as in the pilot driver
 *   --apply                    write to the database (default: dry-run, counts only)
 *
 * Unknown flags are errors: a mistyped `--aply` must not silently mean "dry-run".
 */
import path from 'node:path';

export interface LoadArgs {
  readonly mode: 'dry-run' | 'apply';
  readonly ledgerDir: string;
  readonly accountId: string;
  readonly agencyDomains: readonly string[];
  readonly unknownStartDates: readonly string[];
}

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--ledger-dir',
  '--account-id',
  '--agency-domain',
  '--unknown-start-date',
]);
const REPEATABLE: ReadonlySet<string> = new Set(['--agency-domain', '--unknown-start-date']);
const BOOL_FLAGS: ReadonlySet<string> = new Set(['--apply']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const isIsoDate = (v: string): boolean => ISO.test(v) && !Number.isNaN(Date.parse(v));

export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  const single = new Map<string, string>();
  const many = new Map<string, string[]>();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    if (BOOL_FLAGS.has(a)) {
      if (apply) throw new Error(`${a} given twice`);
      apply = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${a} needs a value`);
    i++;
    if (REPEATABLE.has(a)) {
      const list = many.get(a) ?? [];
      if (!list.includes(next)) list.push(next);
      many.set(a, list);
    } else {
      if (single.has(a)) throw new Error(`${a} given twice`);
      single.set(a, next);
    }
  }

  const ledgerDir = single.get('--ledger-dir');
  if (ledgerDir === undefined || !path.isAbsolute(ledgerDir)) {
    throw new Error('--ledger-dir must be an absolute path');
  }
  const accountId = single.get('--account-id');
  if (accountId === undefined || !UUID.test(accountId)) {
    throw new Error('--account-id UUID is required');
  }
  const agencyDomains = (many.get('--agency-domain') ?? []).map((d) => {
    const domain = d.trim().toLowerCase();
    if (!DOMAIN.test(domain)) throw new Error('--agency-domain must be a bare domain name');
    return domain;
  });
  const unknownStartDates = many.get('--unknown-start-date') ?? [];
  for (const d of unknownStartDates) {
    if (!isIsoDate(d)) throw new Error('--unknown-start-date must be YYYY-MM-DD');
  }
  return {
    mode: apply ? 'apply' : 'dry-run',
    ledgerDir,
    accountId: accountId.toLowerCase(),
    agencyDomains: [...new Set(agencyDomains)],
    unknownStartDates,
  };
}
