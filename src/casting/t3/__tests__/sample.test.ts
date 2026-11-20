import { describe, expect, it } from 'vitest';
import { allocate, stratifiedSample, type SampleItem } from '../sample';

/** Synthetic ids: nothing here is a real file. */
const pool = (spec: Record<string, number>): SampleItem[] =>
  Object.entries(spec).flatMap(([docClass, n]) =>
    Array.from({ length: n }, (_, i) => ({
      fileId: `${docClass}-${String(i).padStart(4, '0')}`,
      docClass,
    })),
  );

const SPEC = { gslides: 600, pptx: 350, pdf: 280, gdoc: 190, docx: 34, gsheet: 33 };

describe('stratifiedSample: determinism', () => {
  it('same input and seed give the identical sample', () => {
    const a = stratifiedSample(pool(SPEC), 120, 'seed-one');
    const b = stratifiedSample(pool(SPEC), 120, 'seed-one');
    expect(b).toEqual(a);
    expect(a.fileIds).toHaveLength(120);
  });

  it('a different seed gives a different choice of the same size', () => {
    const a = stratifiedSample(pool(SPEC), 120, 'seed-one');
    const b = stratifiedSample(pool(SPEC), 120, 'seed-two');
    expect(b.fileIds).toHaveLength(120);
    expect(b.fileIds).not.toEqual(a.fileIds);
    expect(b.sampleByClass).toEqual(a.sampleByClass);
  });

  it('the order of the input is irrelevant', () => {
    const items = pool(SPEC);
    const rev = (x: SampleItem): string => x.fileId.split('').reverse().join('');
    const shuffled = [...items].sort((x, y) => (rev(x) < rev(y) ? -1 : 1));
    expect(shuffled.map((i) => i.fileId)).not.toEqual(items.map((i) => i.fileId));
    expect(stratifiedSample(shuffled, 120, 's')).toEqual(stratifiedSample(items, 120, 's'));
  });

  it('a duplicated id counts once', () => {
    const items = pool({ gdoc: 10 });
    const twice = [...items, ...items];
    expect(stratifiedSample(twice, 4, 's')).toEqual(stratifiedSample(items, 4, 's'));
    expect(stratifiedSample(twice, 4, 's').pool).toBe(10);
  });

  it('the sample is sorted by file id and has no repeats', () => {
    const s = stratifiedSample(pool(SPEC), 120, 'x');
    expect([...s.fileIds]).toEqual([...s.fileIds].sort());
    expect(new Set(s.fileIds).size).toBe(s.fileIds.length);
  });

  it('a larger sample of one class extends the smaller one (rank order per seed and class)', () => {
    const small = stratifiedSample(pool({ gdoc: 50 }), 10, 's');
    const large = stratifiedSample(pool({ gdoc: 50 }), 11, 's');
    expect(small.fileIds.every((id) => large.fileIds.includes(id))).toBe(true);
  });

  it('rejects an empty seed and a bad size', () => {
    expect(() => stratifiedSample(pool(SPEC), 120, '')).toThrow(/seed/);
    expect(() => stratifiedSample(pool(SPEC), 0, 's')).toThrow(/size/);
    expect(() => stratifiedSample(pool(SPEC), 1.5, 's')).toThrow(/size/);
  });
});

describe('stratifiedSample: stratification', () => {
  it('is proportional by class and totals the requested size', () => {
    const s = stratifiedSample(pool(SPEC), 120, 'seed');
    const total = Object.values(SPEC).reduce((a, b) => a + b, 0);
    expect(Object.values(s.sampleByClass).reduce((a, b) => a + b, 0)).toBe(120);
    for (const [c, n] of Object.entries(SPEC)) {
      const share = (120 * n) / total;
      const got = s.sampleByClass[c] as number;
      // within one cell of the exact share, except where the one-per-class minimum lifts it
      expect(Math.abs(got - share)).toBeLessThanOrEqual(1.0001);
    }
    expect(s.poolByClass).toEqual(SPEC);
    expect(s.pool).toBe(total);
  });

  it('keeps at least one cell for every class that has any, however small', () => {
    const s = stratifiedSample(pool({ gslides: 1000, pdf: 500, gsheet: 3, text: 1 }), 20, 'seed');
    expect(s.sampleByClass['gsheet']).toBeGreaterThanOrEqual(1);
    expect(s.sampleByClass['text']).toBe(1);
    expect(Object.values(s.sampleByClass).reduce((a, b) => a + b, 0)).toBe(20);
  });

  it('every picked id belongs to the class it is counted under', () => {
    const s = stratifiedSample(pool(SPEC), 120, 'seed');
    const counted: Record<string, number> = {};
    for (const id of s.fileIds) {
      const c = id.split('-')[0] as string;
      counted[c] = (counted[c] ?? 0) + 1;
    }
    expect(counted).toEqual(s.sampleByClass);
  });

  it('returns the whole pool when it is not larger than the sample', () => {
    const s = stratifiedSample(pool({ gdoc: 5, pdf: 3 }), 120, 'seed');
    expect(s.fileIds).toHaveLength(8);
    expect(s.sampleByClass).toEqual({ gdoc: 5, pdf: 3 });
  });

  it('with fewer slots than classes the largest classes win, ties by name', () => {
    const s = stratifiedSample(pool({ a: 5, b: 5, c: 9, d: 1 }), 2, 'seed');
    expect(s.sampleByClass).toEqual({ a: 1, c: 1 });
  });

  it('an empty pool gives an empty sample', () => {
    const s = stratifiedSample([], 10, 'seed');
    expect(s.fileIds).toEqual([]);
    expect(s.pool).toBe(0);
  });
});

describe('allocate', () => {
  it('never exceeds a class size and sums to the size', () => {
    const m = allocate({ a: 2, b: 100, c: 100 }, 50);
    expect(m.get('a')).toBeLessThanOrEqual(2);
    expect([...m.values()].reduce((x, y) => x + y, 0)).toBe(50);
  });

  it('hands out remainders deterministically', () => {
    const one = allocate({ a: 10, b: 10, c: 10 }, 10);
    const two = allocate({ c: 10, b: 10, a: 10 }, 10);
    expect([...one.entries()].sort()).toEqual([...two.entries()].sort());
    expect([...one.values()].reduce((x, y) => x + y, 0)).toBe(10);
  });
});
