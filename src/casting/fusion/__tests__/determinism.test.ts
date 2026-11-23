import { describe, expect, it } from 'vitest';
import { fuse } from '../fuse';
import { assertExperienceInvariants } from '../invariants';
import { SERVE_MIN_CONFIDENCE, SERVE_MIN_TIERS } from '../constants';
import type { FusionEvidence, FusionInput } from '../types';
import { generateInput, shuffle, uid } from './fixtures';

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

/** The whole output as one string: rows, hashes, ids, links, metrics. */
const canon = (input: FusionInput): string => JSON.stringify(fuse(input));

describe('rebuild is a deterministic pure function of its input', () => {
  it('the same input twice gives byte-identical output (rows, hashes, ids, metrics)', () => {
    for (const seed of SEEDS) {
      const input = generateInput(seed);
      expect(canon(input)).toBe(canon(input));
    }
  });

  it('a rebuild from a rebuilt copy of the input is identical (no hidden state between calls)', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const a = canon(generateInput(seed));
      const b = canon(generateInput(seed));
      expect(a).toBe(b);
    }
  });

  it('the order of any input list does not matter', () => {
    for (const seed of SEEDS) {
      const input = generateInput(seed);
      const reference = canon(input);
      for (const k of [1, 2, 3]) {
        const shuffled: FusionInput = {
          ...input,
          evidence: shuffle(input.evidence, seed * 31 + k),
          campaigns: shuffle(input.campaigns, seed + 2 * k),
          pieces: shuffle(input.pieces, seed + 3 * k),
          staff: shuffle(input.staff, seed + 4 * k),
        };
        expect(canon(shuffled)).toBe(reference);
      }
    }
  });

  it('hashes and ids are stable and unique inside one rebuild', () => {
    for (const seed of SEEDS) {
      const out = fuse(generateInput(seed));
      const hashes = out.claims.map((c) => c.row.experienceHash);
      const ids = out.claims.map((c) => c.row.id);
      expect(new Set(hashes).size).toBe(hashes.length);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...hashes].sort()).toEqual(hashes); // sorted output
    }
  });

  it('the generator reaches the interesting cases (not a vacuous test)', () => {
    let served = 0;
    let conflicting = 0;
    let unconfirmed = 0;
    let superseded = 0;
    let dropped = 0;
    for (const seed of SEEDS) {
      const m = fuse(generateInput(seed)).metrics;
      served += m.claims.served;
      conflicting += m.claims.withheld.conflicting;
      unconfirmed += m.claims.withheld.unconfirmed;
      superseded += m.superseded;
      dropped += m.staffRowsDropped.notCurrent;
    }
    expect(served).toBeGreaterThan(20);
    expect(unconfirmed).toBeGreaterThan(20);
    expect(conflicting).toBeGreaterThan(0);
    expect(superseded).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
  });
});

describe('invariants of every rebuild', () => {
  it('rows satisfy the table constraints; served rows meet the gate', () => {
    for (const seed of SEEDS) {
      const input = generateInput(seed);
      const out = fuse(input);
      const currentStaff = new Set(input.staff.filter((s) => s.isCurrent).map((s) => s.staffId));
      for (const c of out.claims) {
        assertExperienceInvariants(c.row);
        expect(currentStaff.has(c.row.staffId)).toBe(true);
        if (c.row.withheldReason === null) {
          expect(c.row.confidence).toBeGreaterThanOrEqual(SERVE_MIN_CONFIDENCE);
          expect(c.tiers.length).toBeGreaterThanOrEqual(SERVE_MIN_TIERS);
          expect(c.tiers).toContain('T3');
          expect(c.projectKey.startsWith('none:')).toBe(false);
        } else {
          expect(['conflicting', 'unconfirmed']).toContain(c.row.withheldReason);
        }
      }
      expect(out.metrics.claims.servedWithMinTiers).toBe(out.metrics.claims.served);
    }
  });

  it('every claim lists only existing, resolved, same-account rows of its own person', () => {
    for (const seed of SEEDS) {
      const input = generateInput(seed);
      const byId = new Map(input.evidence.map((r) => [r.id, r]));
      for (const c of fuse(input).claims) {
        expect(c.evidenceIds.length).toBeGreaterThan(0);
        expect([...c.evidenceIds].sort()).toEqual(c.evidenceIds);
        expect(new Set(c.evidenceIds).size).toBe(c.evidenceIds.length);
        for (const id of c.evidenceIds) {
          const r = byId.get(id) as FusionEvidence;
          expect(r).toBeDefined();
          expect(r.personKind).toBe('staff');
          expect(r.withheldReason).toBeNull();
          expect(r.staffId).toBe(c.row.staffId);
          expect(r.accountId).toBe(c.row.accountId);
        }
      }
    }
  });

  it('external and quarantined rows never change a claim', () => {
    for (const seed of SEEDS) {
      const input = generateInput(seed);
      const extra: FusionEvidence[] = input.evidence
        .filter((r) => r.source === 'drive_content' && r.personKind === 'staff')
        .slice(0, 25)
        .map((r, i) => ({
          ...r,
          id: uid(10, i + 1),
          staffId: null,
          personKind: i % 2 === 0 ? ('external_unresolved' as const) : ('quarantined' as const),
          withheldReason: i % 2 === 0 ? ('unresolved' as const) : ('ambiguous' as const),
          confidence: 0.99,
        }));
      const base = fuse(input).claims;
      const withExtra = fuse({ ...input, evidence: [...input.evidence, ...extra] }).claims;
      expect(JSON.stringify(withExtra)).toBe(JSON.stringify(base));
    }
  });

  it('rows of an older extractor version change nothing', () => {
    for (const seed of SEEDS) {
      const input = generateInput(seed);
      const stale: FusionEvidence[] = input.evidence.map((r, i) => ({
        ...r,
        id: uid(11, i + 1),
        extractorVersion: r.extractorVersion.replace('v1', 'v0').replace('v2', 'v1'),
        confidence: 0.99,
      }));
      // A stale copy of a row whose file also has a newer row is dropped; a file that
      // only has stale copies would not exist here because every file keeps its original.
      const out = fuse({ ...input, evidence: [...input.evidence, ...stale] });
      expect(JSON.stringify(out.claims)).toBe(JSON.stringify(fuse(input).claims));
      expect(out.metrics.superseded).toBeGreaterThanOrEqual(stale.length);
    }
  });

  it('scales: a few hundred projects rebuild in well under a few seconds', () => {
    const input = generateInput(7, { staff: 80, projects: 400 });
    const t0 = Date.now();
    const out = fuse(input);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.claims.length).toBeGreaterThan(100);
  });
});
