/**
 * Grounding: a model answer is checked against the text the model was given.
 *
 *  - A name that does not appear in that text (after diacritic / case folding)
 *    is a hallucination or a heavy rewrite: the mention is dropped and counted.
 *  - A quote that is not a verbatim excerpt is dropped (the row keeps the
 *    name and role) and counted, so the stored quote is always real text.
 *  - Where the quote sits gives `location` ("slide 4", "sheet: Staffing"),
 *    taken from the extractor's own markers, never from the model.
 *
 * Both rates are label-free quality proxies for the pilot report.
 */
import type { RawMention } from './schema';

const SPECIAL: Readonly<Record<string, string>> = {
  ł: 'l',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
};

/** Lower-case, diacritics stripped, every non-letter/digit run turned into one space. */
export function foldForMatch(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[łøđðþßæœı]/g, (c) => SPECIAL[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface GroundedText {
  readonly folded: string;
  readonly foldedTokens: ReadonlySet<string>;
  readonly original: string;
}

export function groundingOf(text: string): GroundedText {
  const folded = ` ${foldForMatch(text)} `;
  return { folded, foldedTokens: new Set(folded.split(' ').filter(Boolean)), original: text };
}

/** Whole-name phrase match, else every name token (2+ letters) present ("Last, First" order). */
export function nameIsGrounded(g: GroundedText, rawName: string): boolean {
  const name = foldForMatch(rawName);
  if (name.length === 0) return false;
  if (g.folded.includes(` ${name} `)) return true;
  const tokens = name.split(' ').filter((t) => t.length >= 2);
  return tokens.length >= 2 && tokens.every((t) => g.foldedTokens.has(t));
}

export function quoteIsGrounded(g: GroundedText, quote: string): boolean {
  const q = foldForMatch(quote.replace(/\[link\]/g, ' '));
  return q.length > 0 && g.folded.includes(` ${q} `);
}

/** Position of the quote in the original text, via a whitespace-tolerant search; -1 if absent. */
function indexOfQuote(text: string, quote: string): number {
  const direct = text.indexOf(quote);
  if (direct >= 0) return direct;
  const words = quote.split(/\s+/).filter(Boolean).slice(0, 12);
  if (words.length === 0) return -1;
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = new RegExp(esc.join('\\s+')).exec(text);
  return m ? m.index : -1;
}

/** `slide N` / `sheet: <tab>` of the nearest marker before the quote; null for other documents. */
export function locationOf(text: string, quote: string | null): string | null {
  if (quote === null) return null;
  const at = indexOfQuote(text, quote);
  if (at < 0) return null;
  const before = text.slice(0, at);
  const slide = [...before.matchAll(/^## Slide (\d+)\s*$/gm)].pop();
  const sheet = [...before.matchAll(/^## Sheet: (.+)$/gm)].pop();
  if (slide && (!sheet || (slide.index as number) > (sheet.index as number))) {
    return `slide ${slide[1]}`;
  }
  if (sheet) return `sheet: ${(sheet[1] as string).trim().slice(0, 80)}`;
  return null;
}

export interface GroundingStats {
  droppedUngroundedName: number;
  quoteDroppedUngrounded: number;
}

export interface GroundedMention extends RawMention {
  readonly location: string | null;
}

export function groundMentions(
  text: string,
  mentions: readonly RawMention[],
): { mentions: GroundedMention[]; stats: GroundingStats } {
  const g = groundingOf(text);
  const stats: GroundingStats = { droppedUngroundedName: 0, quoteDroppedUngrounded: 0 };
  const out: GroundedMention[] = [];
  for (const m of mentions) {
    if (!nameIsGrounded(g, m.rawName)) {
      stats.droppedUngroundedName++;
      continue;
    }
    let quote = m.quote;
    if (quote !== null && !quoteIsGrounded(g, quote)) {
      quote = null;
      stats.quoteDroppedUngrounded++;
    }
    out.push({ ...m, quote, location: locationOf(text, quote) });
  }
  return { mentions: out, stats };
}
