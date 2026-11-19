/**
 * Period text to dates. The model returns the period as written; code turns it
 * into `period_start` / `period_end` only when the text is unambiguous, else
 * both stay null (a project period is derived from folder context elsewhere,
 * never guessed from a file date).
 *
 * Understood: 2023, 2023-05, 2023-05-14, "May 2023", "Q3 2023", and ranges of
 * those joined by "-", "to", an en dash or "through". Anything else: null.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export interface Period {
  readonly start: string | null;
  readonly end: string | null;
}

const NONE: Period = { start: null, end: null };
const MIN_YEAR = 1990;

const pad = (n: number): string => String(n).padStart(2, '0');

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** One point of a range as an inclusive [start, end] pair, or null. */
function point(raw: string, maxYear: number): [string, string] | null {
  const t = raw.trim().toLowerCase().replace(/[.,]/g, '');
  let m = /^(\d{4})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    return y >= MIN_YEAR && y <= maxYear ? [`${y}-01-01`, `${y}-12-31`] : null;
  }
  m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (y < MIN_YEAR || y > maxYear || mo < 1 || mo > 12) return null;
    return [`${y}-${pad(mo)}-01`, `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`];
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y < MIN_YEAR || y > maxYear || mo < 1 || mo > 12 || d < 1 || d > lastDay(y, mo))
      return null;
    const iso = `${y}-${pad(mo)}-${pad(d)}`;
    return [iso, iso];
  }
  m = /^([a-z]+) (\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS[m[1] as string];
    const y = Number(m[2]);
    if (!mo || y < MIN_YEAR || y > maxYear) return null;
    return [`${y}-${pad(mo)}-01`, `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`];
  }
  m = /^q([1-4]) (\d{4})$/.exec(t);
  if (m) {
    const q = Number(m[1]);
    const y = Number(m[2]);
    if (y < MIN_YEAR || y > maxYear) return null;
    const first = (q - 1) * 3 + 1;
    const last = first + 2;
    return [`${y}-${pad(first)}-01`, `${y}-${pad(last)}-${pad(lastDay(y, last))}`];
  }
  return null;
}

/** `now` bounds the plausible years (a period after next year is a misread). */
export function parsePeriod(text: string | null, now: Date): Period {
  if (!text) return NONE;
  const maxYear = now.getUTCFullYear() + 1;
  const single = point(text, maxYear);
  if (single) return { start: single[0], end: single[1] };
  const parts = text.split(
    /\s+(?:to|through|thru)\s+|\s*[–—]\s*|\s+-\s+|(?<=\d)-(?=[A-Za-z])|(?<=^\d{4})-(?=\d{4}$)/i,
  );
  if (parts.length !== 2) return NONE;
  const a = point(parts[0] as string, maxYear);
  const b = point(parts[1] as string, maxYear);
  if (!a || !b || b[1] < a[0]) return NONE;
  return { start: a[0], end: b[1] };
}
