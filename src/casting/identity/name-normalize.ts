/**
 * Name normalisation. Pure string functions, no I/O.
 *
 * A raw name becomes lower-case ASCII tokens in up to three folds:
 *  - primary:  diacritics stripped ("Zoë" -> "zoe", "Łukasz" -> "lukasz"),
 *              Cyrillic transliterated, hyphens and dots turned into spaces.
 *  - german:   the same, but with umlauts written out ("Müller" -> "mueller").
 *              Only produced when the name has an umlaut.
 *  - loose:    a coarse transliteration fold applied on top of primary, so that
 *              spelling families collapse ("Yuri", "Yuriy", "Iurii", "Jurij").
 *              Used only by the transliteration tier, never alone as a decision.
 */

export interface NameForms {
  /** Primary tokens in written order (after "Last, First" flipping). */
  readonly tokens: readonly string[];
  /** Tokens with umlauts written out, or null when identical to primary. */
  readonly germanTokens: readonly string[] | null;
  /** Loose-folded tokens (derived from primary). */
  readonly looseTokens: readonly string[];
  /** Nicknames given in quotes or parentheses, as primary tokens. */
  readonly hints: readonly string[];
}

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
  ħ: 'h',
};

const UMLAUT: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue' };

const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md']);

/** Strips diacritics and maps special letters; optionally writes umlauts out first. */
function foldToAscii(input: string, germanUmlauts: boolean): string {
  let out = '';
  for (const ch of input.toLowerCase()) {
    if (germanUmlauts && UMLAUT[ch] !== undefined) {
      out += UMLAUT[ch];
    } else if (SPECIAL[ch] !== undefined) {
      out += SPECIAL[ch];
    } else if (CYRILLIC[ch] !== undefined) {
      out += CYRILLIC[ch];
    } else {
      out += ch;
    }
  }
  return out.normalize('NFD').replace(/\p{M}+/gu, '');
}

function tokenize(folded: string): string[] {
  // Apostrophes join ("O'Brien" -> "obrien"); every other non-alphanumeric splits.
  return folded
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0);
}

function stripHonorificsAndSuffixes(tokens: string[]): string[] {
  let out = tokens;
  while (out.length > 1 && HONORIFICS.has(out[0] as string)) out = out.slice(1);
  while (out.length > 1 && SUFFIXES.has(out[out.length - 1] as string)) out = out.slice(0, -1);
  return out;
}

/** Quoted or parenthesised nickname hints; returns the text without them. */
function extractHints(raw: string): { main: string; hints: string[] } {
  const hints: string[] = [];
  const main = raw
    .replace(/[([]([^)\]]*)[)\]]/g, (_m, inner: string) => {
      hints.push(inner);
      return ' ';
    })
    .replace(/["“”]([^"“”]*)["“”]/g, (_m, inner: string) => {
      hints.push(inner);
      return ' ';
    })
    .replace(/(^|\s)'([^']+)'(?=\s|$)/g, (_m, lead: string, inner: string) => {
      hints.push(inner);
      return `${lead} `;
    });
  return { main, hints };
}

/** "Rivera, Alex" -> "Alex Rivera". Only for a single short comma form. */
function flipComma(main: string): string {
  const parts = main.split(',').map((p) => p.trim());
  if (parts.length === 2) {
    const [left, right] = parts as [string, string];
    // "Alex Rivera, Jr." keeps its order: the right side is only a suffix.
    const rightTokens = tokenize(foldToAscii(right, false));
    if (rightTokens.length > 0 && rightTokens.every((t) => SUFFIXES.has(t))) return left;
    const leftN = tokenize(foldToAscii(left, false)).length;
    if (leftN >= 1 && leftN <= 2 && rightTokens.length >= 1 && rightTokens.length <= 2) {
      return `${right} ${left}`;
    }
    // Anything else after a comma is a trailing role or company: drop it.
    return left;
  }
  if (parts.length > 2) return parts[0] as string;
  return main;
}

/**
 * Coarse transliteration fold for ONE primary token. Collapses common spelling
 * families; two names equal only here are a transliteration-tier match.
 */
export function looseFoldToken(token: string): string {
  let t = token;
  t = t.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u');
  t = t.replace(/^i(?=[uae])/, 'y'); // Iurii, Iaroslav
  t = t.replace(/j/g, 'y');
  t = t.replace(/(iy|yy|ii|yi)/g, 'y');
  t = t.replace(/ei$/, 'ey');
  t = t.replace(/i$/, 'y');
  t = t.replace(/kh/g, 'h').replace(/w/g, 'v').replace(/x/g, 'ks').replace(/ck/g, 'k');
  t = t.replace(/([a-z])\1+/g, '$1');
  return t;
}

/** Normalises a raw name. Returns tokens=[] when nothing usable remains. */
export function normalizeName(raw: string): NameForms {
  const { main: withoutHints, hints: rawHints } = extractHints(raw.normalize('NFKC'));
  const main = flipComma(withoutHints);

  const tokens = stripHonorificsAndSuffixes(tokenize(foldToAscii(main, false)));
  const germanTokens = stripHonorificsAndSuffixes(tokenize(foldToAscii(main, true)));
  const german = germanTokens.join(' ') === tokens.join(' ') ? null : germanTokens;
  const hints = rawHints.flatMap((h) => tokenize(foldToAscii(h, false)));

  return {
    tokens,
    germanTokens: german,
    looseTokens: tokens.map(looseFoldToken),
    hints,
  };
}

/** Order-sensitive key: "zofia marek lindqvist". */
export const fullKey = (tokens: readonly string[]): string => tokens.join(' ');

/** Order-insensitive key, so "Volkova Sasha" equals "Sasha Volkova". */
export const setKey = (tokens: readonly string[]): string => [...tokens].sort().join(' ');

/** Spaces removed, so "O Dwyer" equals "ODwyer" and "Marek Lindqvist" equals "MarekLindqvist". */
export const compactKey = (tokens: readonly string[]): string => tokens.join('');

/** Every key under which an exact (case, diacritic, order, spacing insensitive) match is found. */
export const exactKeysOf = (tokens: readonly string[]): string[] =>
  tokens.length === 0 ? [] : [fullKey(tokens), setKey(tokens), compactKey(tokens)];

/** First and last token only (middle names and extra words dropped), or null for < 2 tokens. */
export function firstLastKey(tokens: readonly string[]): string | null {
  if (tokens.length < 2) return null;
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

/** Normalises an email for exact lookup: lower-case, no mailto:, no angle brackets. */
export function normalizeEmail(raw: string): string | null {
  const m = raw
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^<|>$/g, '')
    .trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m) ? m : null;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

/** Optimal-string-alignment distance, capped: returns > max as max + 1. */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [];
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] as number) + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j] as number;
    prev = cur;
  }
  return Math.min(prev[b.length] as number, max + 1);
}
