/**
 * Fitting a document's text to the per-call character cap (40,000 at base).
 *
 * Plain documents and decks: keep the head and the tail (credits and team
 * slides usually sit at the start or at the very end), drop the middle.
 *
 * Sheets are the exception, and the reason this module exists: about a third
 * exceed the cap, and a head-only cut would keep one big tab and lose every
 * small one, where a staffing or credits tab usually is. A sheet is split on
 * its tab markers ("## Sheet: <name>", written by the extractor) and each tab
 * gets a fair share of the cap, unused share flowing to the larger tabs; every
 * tab keeps its top rows (header and first rows). Tabs that cannot get a
 * useful share are listed by name instead of silently vanishing.
 *
 * The result says what was cut. Nothing here makes a second model call.
 */
import type { DocClass } from './types';

export const SHEET_TAB_MARKER = /^## Sheet: /m;
/** A tab gets at least this many characters, or it is omitted (and named). */
const MIN_TAB_CHARS = 400;
const HEAD_SHARE = 0.65;
const NOTE_RESERVE = 400;

export interface FitResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly sentChars: number;
  /** Sheets only: tabs left out entirely. */
  readonly omittedTabs: readonly string[];
}

const untouched = (text: string): FitResult => ({
  text,
  truncated: false,
  originalChars: text.length,
  sentChars: text.length,
  omittedTabs: [],
});

/** Cut `s` to at most `max` characters at a line boundary where one exists. */
function headAtLine(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('\n', max);
  return s.slice(0, cut > max * 0.5 ? cut : max);
}

function tailAtLine(s: string, max: number): string {
  if (s.length <= max) return s;
  const from = s.length - max;
  const cut = s.indexOf('\n', from);
  return s.slice(cut >= 0 && cut - from < max * 0.5 ? cut + 1 : from);
}

function fitPlain(text: string, cap: number): FitResult {
  const marker = '\n[... middle of the document omitted ...]\n';
  const budget = cap - marker.length;
  const head = headAtLine(text, Math.floor(budget * HEAD_SHARE));
  const tail = tailAtLine(text.slice(head.length), budget - head.length);
  const out = head + marker + tail;
  return {
    text: out,
    truncated: true,
    originalChars: text.length,
    sentChars: out.length,
    omittedTabs: [],
  };
}

/** Water-filling: equal shares, unused share redistributed, in tab order. */
function allocate(sizes: readonly number[], budget: number): number[] {
  const alloc = sizes.map(() => 0);
  let remaining = budget;
  let open = sizes.map((_, i) => i);
  while (open.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    if (share <= 0) break;
    const stillOpen: number[] = [];
    for (const i of open) {
      const want = (sizes[i] as number) - (alloc[i] as number);
      const give = Math.min(want, share);
      alloc[i] = (alloc[i] as number) + give;
      remaining -= give;
      if (want > give) stillOpen.push(i);
    }
    open = stillOpen;
  }
  return alloc;
}

function fitSheet(text: string, cap: number): FitResult {
  const starts: number[] = [];
  const re = /^## Sheet: /gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) starts.push(m.index);
  if (starts.length === 0) return fitPlain(text, cap);

  const preamble = text.slice(0, starts[0]);
  const tabs = starts.map((s, i) => text.slice(s, starts[i + 1] ?? text.length));
  const titleOf = (tab: string): string =>
    (tab.split('\n', 1)[0] ?? '').replace('## Sheet: ', '').trim();

  const budget = cap - preamble.length - NOTE_RESERVE;
  // Tabs beyond what the minimum share allows are named, not kept.
  const keepCount = Math.max(1, Math.min(tabs.length, Math.floor(budget / MIN_TAB_CHARS)));
  const kept = tabs.slice(0, keepCount);
  const dropped = tabs.slice(keepCount).map(titleOf);

  const alloc = allocate(
    kept.map((t) => t.length),
    budget,
  );
  const parts = kept.map((tab, i) => {
    const room = alloc[i] as number;
    if (tab.length <= room) return tab;
    const body = headAtLine(tab, Math.max(0, room - 40));
    return `${body.replace(/\n+$/, '')}\n[... rows omitted ...]\n\n`;
  });
  let out = preamble + parts.join('');
  if (dropped.length > 0) {
    out += `[... tabs omitted: ${dropped.slice(0, 30).join(', ')}${dropped.length > 30 ? ', ...' : ''} ...]\n`;
  }
  return {
    text: out,
    truncated: true,
    originalChars: text.length,
    sentChars: out.length,
    omittedTabs: dropped,
  };
}

export function fitToCap(text: string, docClass: DocClass, cap: number): FitResult {
  if (text.length <= cap) return untouched(text);
  return docClass === 'gsheet' ? fitSheet(text, cap) : fitPlain(text, cap);
}
