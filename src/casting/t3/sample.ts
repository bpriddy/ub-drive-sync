/**
 * Deterministic stratified sample of the kept cells (pilot P1).
 *
 * Pure: the result is a function of (the set of file ids and their classes, size, seed),
 * nothing else. No Math.random, no Date, no input-order dependence: items are de-duplicated
 * and sorted by file id first, and a stable hash of `seed|class|fileId` ranks the files
 * inside each class. The same input and seed always give the same sample; another seed gives
 * another one.
 *
 * Stratification is by document class, proportional to the class size (largest remainder),
 * with at least one cell for every class that has any cell, as long as the sample is large
 * enough to hold one per class. If the sample is smaller than the number of classes, the
 * largest classes win a slot (ties broken by class name).
 */
import crypto from 'node:crypto';

export interface SampleItem {
  readonly fileId: string;
  readonly docClass: string;
}

export interface SampleResult {
  /** File ids of the sample, sorted ascending. */
  readonly fileIds: readonly string[];
  readonly seed: string;
  readonly requested: number;
  /** Cells available to sample from (after de-duplication by file id). */
  readonly pool: number;
  readonly poolByClass: Readonly<Record<string, number>>;
  readonly sampleByClass: Readonly<Record<string, number>>;
}

const rank = (seed: string, docClass: string, fileId: string): string =>
  crypto.createHash('sha256').update(`${seed}\u0000${docClass}\u0000${fileId}`).digest('hex');

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How many cells each class contributes. Pure arithmetic on the class sizes. */
export function allocate(
  sizes: Readonly<Record<string, number>>,
  size: number,
): Map<string, number> {
  const classes = Object.keys(sizes)
    .filter((c) => (sizes[c] as number) > 0)
    .sort(cmp);
  const total = classes.reduce((n, c) => n + (sizes[c] as number), 0);
  const out = new Map<string, number>();
  if (size >= total) {
    for (const c of classes) out.set(c, sizes[c] as number);
    return out;
  }
  if (classes.length > size) {
    const bySize = [...classes].sort(
      (a, b) => (sizes[b] as number) - (sizes[a] as number) || cmp(a, b),
    );
    for (const c of bySize.slice(0, size)) out.set(c, 1);
    return out;
  }
  const exact = new Map<string, number>();
  let sum = 0;
  for (const c of classes) {
    const e = (size * (sizes[c] as number)) / total;
    exact.set(c, e);
    const n = Math.min(sizes[c] as number, Math.max(1, Math.floor(e)));
    out.set(c, n);
    sum += n;
  }
  // The minimum of one per class can overshoot: take back from the class that is furthest above its share.
  while (sum > size) {
    let pick: string | null = null;
    let best = -Infinity;
    for (const c of classes) {
      const n = out.get(c) as number;
      if (n <= 1) continue;
      const over = n - (exact.get(c) as number);
      if (over > best || (over === best && pick !== null && cmp(c, pick) < 0)) {
        best = over;
        pick = c;
      }
    }
    if (pick === null) break;
    out.set(pick, (out.get(pick) as number) - 1);
    sum--;
  }
  // Hand the remaining slots to the classes furthest below their share, one at a time.
  while (sum < size) {
    let pick: string | null = null;
    let best = -Infinity;
    for (const c of classes) {
      const n = out.get(c) as number;
      if (n >= (sizes[c] as number)) continue;
      const under = (exact.get(c) as number) - n;
      if (under > best || (under === best && pick !== null && cmp(c, pick) < 0)) {
        best = under;
        pick = c;
      }
    }
    if (pick === null) break;
    out.set(pick, (out.get(pick) as number) + 1);
    sum++;
  }
  return out;
}

export function stratifiedSample(
  items: readonly SampleItem[],
  size: number,
  seed: string,
): SampleResult {
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError('sample size must be an integer >= 1');
  if (seed === '') throw new Error('a sample seed is required');
  const byId = new Map<string, SampleItem>();
  for (const it of items) if (!byId.has(it.fileId)) byId.set(it.fileId, it);
  const sorted = [...byId.values()].sort((a, b) => cmp(a.fileId, b.fileId));

  const groups = new Map<string, string[]>();
  for (const it of sorted) {
    const g = groups.get(it.docClass) ?? [];
    g.push(it.fileId);
    groups.set(it.docClass, g);
  }
  const poolByClass: Record<string, number> = {};
  for (const c of [...groups.keys()].sort(cmp)) poolByClass[c] = (groups.get(c) as string[]).length;

  const alloc = allocate(poolByClass, size);
  const picked: string[] = [];
  const sampleByClass: Record<string, number> = {};
  for (const [c, n] of [...alloc.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const ids = (groups.get(c) as string[])
      .map((id) => ({ id, r: rank(seed, c, id) }))
      .sort((a, b) => cmp(a.r, b.r) || cmp(a.id, b.id))
      .slice(0, n)
      .map((x) => x.id);
    sampleByClass[c] = ids.length;
    picked.push(...ids);
  }
  return {
    fileIds: picked.sort(cmp),
    seed,
    requested: size,
    pool: sorted.length,
    poolByClass,
    sampleByClass,
  };
}
