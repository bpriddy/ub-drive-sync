/**
 * Command-line flags of the stage, parsed purely. Dry-run is the default;
 * apply needs `--apply` together with both approval limits and a ledger dir.
 *
 *   --apply                      switch from dry-run to apply
 *   --max-cells N --max-usd X    the approval; both required with --apply
 *   --model ID --thinking LEVEL  arm (default model gemini-3.5-flash, level LOW)
 *   --parallel N                 1 or 2
 *   --variant tight|base|recall_max
 *   --window-start YYYY-MM-DD    required
 *   --read-text                  dry-run: read documents to size the estimate
 *   --retry-failed
 *   --ledger-dir ABS_PATH        required for apply
 */
import { THINKING_LEVELS, type ThinkingLevelName } from '../../ai/thinking';
import { TRIAGE_VARIANTS, type TriageVariant } from './triage';
import { T3_MAX_PARALLEL } from './types';

export interface T3Args {
  readonly mode: 'dry-run' | 'apply';
  readonly model: string;
  readonly thinkingLevel: ThinkingLevelName;
  readonly parallel: number;
  readonly variant: TriageVariant;
  readonly windowStart: string;
  readonly readText: boolean;
  readonly retryFailed: boolean;
  readonly ledgerDir: string | null;
  readonly approval: { readonly maxCells: number; readonly maxCostUsd: number } | null;
}

export function parseT3Args(argv: readonly string[]): T3Args {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a, next);
      i++;
    } else flags.set(a, true);
  }
  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    if (v === true) throw new Error(`${k} needs a value`);
    return v;
  };
  const num = (k: string): number | undefined => {
    const v = str(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
    return n;
  };

  const windowStart = str('--window-start');
  if (!windowStart || !/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) {
    throw new Error('--window-start YYYY-MM-DD is required');
  }
  const thinking = (str('--thinking') ?? 'LOW').toUpperCase();
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(', ')}`);
  }
  const variant = str('--variant') ?? 'base';
  if (!(TRIAGE_VARIANTS as readonly string[]).includes(variant)) {
    throw new Error(`--variant must be one of ${TRIAGE_VARIANTS.join(', ')}`);
  }
  const parallel = num('--parallel') ?? 1;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > T3_MAX_PARALLEL) {
    throw new Error(`--parallel must be 1..${T3_MAX_PARALLEL}`);
  }
  const apply = flags.get('--apply') === true;
  const maxCells = num('--max-cells');
  const maxUsd = num('--max-usd');
  const ledgerDir = str('--ledger-dir') ?? null;
  let approval: T3Args['approval'] = null;
  if (apply) {
    if (maxCells === undefined || maxUsd === undefined || !(maxCells >= 1) || !(maxUsd > 0)) {
      throw new Error('--apply needs --max-cells (>= 1) and --max-usd (> 0)');
    }
    if (ledgerDir === null) throw new Error('--apply needs --ledger-dir');
    approval = { maxCells, maxCostUsd: maxUsd };
  } else if (maxCells !== undefined || maxUsd !== undefined) {
    throw new Error('--max-cells / --max-usd only mean something with --apply');
  }
  return {
    mode: apply ? 'apply' : 'dry-run',
    model: str('--model') ?? 'gemini-3.5-flash',
    thinkingLevel: thinking as ThinkingLevelName,
    parallel,
    variant: variant as TriageVariant,
    windowStart,
    readText: flags.get('--read-text') === true,
    retryFailed: flags.get('--retry-failed') === true,
    ledgerDir,
    approval,
  };
}
