/**
 * Supersede by `extractor_version`.
 *
 * Layer 1 is append-only: a re-scan with a newer extractor writes NEW rows next
 * to the old ones. Fusion must not count both. For every (source, file) only the
 * rows of the highest extractor_version that has rows for that file are kept. The
 * unit is the file, not the version as a whole, so a partial re-scan replaces the
 * files it reached and leaves the rest on their old version until it gets there.
 */
import type { FusionEvidence } from './types';

const TOKEN = /(\d+)|(\D+)/g;

/**
 * Total order on version strings: digit runs compare as numbers, other runs as
 * text, a digit run before a text run; `t3-x-v10` > `t3-x-v9`. Equal under tokens:
 * plain string order, so the order is total and deterministic.
 */
export function compareExtractorVersion(a: string, b: string): number {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i] as string;
    const y = tb[i] as string;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx !== ny) return nx ? -1 : 1; // a digit run sorts before a text run
    if (nx) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export interface SupersedeResult {
  kept: FusionEvidence[];
  superseded: number;
}

export function supersedeByVersion(rows: readonly FusionEvidence[]): SupersedeResult {
  const newest = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.source}\u0000${r.fileId}`;
    const cur = newest.get(key);
    if (cur === undefined || compareExtractorVersion(r.extractorVersion, cur) > 0) {
      newest.set(key, r.extractorVersion);
    }
  }
  const kept = rows.filter(
    (r) => newest.get(`${r.source}\u0000${r.fileId}`) === r.extractorVersion,
  );
  return { kept, superseded: rows.length - kept.length };
}
