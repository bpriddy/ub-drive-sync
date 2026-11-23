/** Calendar-month helpers (UTC, `YYYY-MM` keys). */

const MONTH = /^(\d{4})-(\d{2})$/;

export function monthOfDay(day: string): string {
  return day.slice(0, 7);
}

export function isMonthKey(m: string): boolean {
  const match = MONTH.exec(m);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

export function nextMonth(m: string): string {
  const [y, mo] = parts(m);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

export function previousMonth(m: string): string {
  const [y, mo] = parts(m);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}

/** First day of the month, YYYY-MM-DD. */
export function monthStart(m: string): string {
  return `${m}-01`;
}

/** Last day of the month, YYYY-MM-DD. */
export function monthEnd(m: string): string {
  const [y, mo] = parts(m);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(last).padStart(2, '0')}`;
}

/** Months from `from` to `to` inclusive; empty when `from` is after `to`. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

function parts(m: string): [number, number] {
  const match = MONTH.exec(m);
  if (match === null) throw new RangeError(`not a YYYY-MM month: ${m}`);
  return [Number(match[1]), Number(match[2])];
}
