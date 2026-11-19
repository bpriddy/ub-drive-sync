import { describe, expect, it } from 'vitest';
import { classifyActor } from '../actors';
import { T2_MAX_CONFIDENCE, claimHash, confidenceOf, emitActivityRow } from '../emit';
import { monthEnd, monthStart, monthsBetween, nextMonth, previousMonth } from '../months';
import { createProjectResolver } from '../project';
import { resolveIdentity } from '../../identity';
import { ACCOUNT, CAMPAIGN, CATALOG, FILES, PIECE, roster } from './fixtures';
import type { StatsGroup } from '../types';

describe('months', () => {
  it('walks over year ends and leap days', () => {
    expect(nextMonth('2025-12')).toBe('2026-01');
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(monthEnd('2025-02')).toBe('2025-02-28');
    expect(monthStart('2025-02')).toBe('2025-02-01');
    expect(monthsBetween('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(monthsBetween('2026-03', '2026-02')).toEqual([]);
  });
  it('rejects a malformed key', () => {
    expect(() => nextMonth('2025-13x')).toThrow(RangeError);
  });
});

describe('classifyActor', () => {
  const cache = new Map<string, string | null>([
    ['people/1', 'Some.Body@Agency.Example'],
    ['people/2', null],
    ['people/3', 'not an email'],
  ]);
  it('classifies every shape', () => {
    expect(classifyActor(' User@Agency.Example ', cache)).toEqual({
      class: 'email',
      email: 'user@agency.example',
    });
    expect(classifyActor('people/1', cache)).toEqual({
      class: 'people_cached',
      email: 'some.body@agency.example',
    });
    expect(classifyActor('people/2', cache).class).toBe('people_unresolved');
    expect(classifyActor('people/3', cache).class).toBe('people_unresolved');
    expect(classifyActor('people/9', cache).class).toBe('people_unresolved');
    expect(classifyActor('(unattributed)', cache).class).toBe('unattributed');
    expect(classifyActor('someone', cache).class).toBe('unrecognised');
  });
});

describe('createProjectResolver', () => {
  const resolver = createProjectResolver(CATALOG);
  const byId = (id: string) => FILES.find((f) => f.fileId === id)!;
  it('a catalog job code gives piece and campaign', () => {
    expect(resolver.resolve(byId('f1'))).toEqual({
      key: 'job:ACME55000216',
      basis: 'job_code',
      jobNumber: 'ACME55000216',
      campaignId: CAMPAIGN,
      pieceId: PIECE,
    });
  });
  it('a code unknown to the catalog keeps the job number and the index campaign', () => {
    const f = { ...byId('f2'), path: 'Acme / [ZZZZ12345678] / x.pdf' };
    expect(resolver.resolve(f)).toMatchObject({
      key: 'job:ZZZZ12345678',
      jobNumber: 'ZZZZ12345678',
      campaignId: CAMPAIGN,
      pieceId: null,
    });
  });
  it('a campaign attribution without a code', () => {
    expect(resolver.resolve(byId('f2'))).toMatchObject({ basis: 'campaign', campaignId: CAMPAIGN });
  });
  it('no code and no known campaign is no project', () => {
    expect(resolver.resolve(byId('f3'))).toBeNull();
    expect(resolver.resolve(byId('f5'))).toBeNull();
  });
  it('a folder name alone is never an identity (no name-key rung)', () => {
    const f = { ...byId('f3'), path: 'Acme / Spring Launch / x.pdf' };
    expect(resolver.resolve(f)).toBeNull();
  });
});

const group = (over: Partial<StatsGroup> = {}): StatsGroup => ({
  fileId: 'f1',
  actor: 'x',
  firstDay: '2025-03-05',
  lastDay: '2025-03-20',
  days: 2,
  edits: 8,
  ...over,
});

describe('confidence', () => {
  it('stays an [ASSUME] placeholder far below the serving threshold', () => {
    expect(confidenceOf({ edits: 1, days: 1 })).toBe(0.1);
    expect(confidenceOf({ edits: 10, days: 1 })).toBe(0.14);
    expect(confidenceOf({ edits: 10, days: 3 })).toBe(0.18);
    expect(confidenceOf({ edits: 100000, days: 31 })).toBe(T2_MAX_CONFIDENCE);
    expect(T2_MAX_CONFIDENCE).toBeLessThan(0.7);
  });
});

describe('claimHash', () => {
  const base = { fileId: 'f1', month: '2025-03', rawName: 'a@b.example', projectKey: 'campaign:c' };
  it('is stable and sensitive to every part of the claim', () => {
    expect(claimHash(base)).toBe(claimHash({ ...base }));
    for (const change of [
      { fileId: 'f2' },
      { month: '2025-04' },
      { rawName: 'c@d.example' },
      { projectKey: 'campaign:d' },
    ]) {
      expect(claimHash({ ...base, ...change })).not.toBe(claimHash(base));
    }
  });
});

describe('emitActivityRow', () => {
  const project = {
    key: 'campaign:c',
    basis: 'campaign' as const,
    jobNumber: null,
    campaignId: CAMPAIGN,
    pieceId: null,
  };
  const ctx = (email: string, day = '2025-03-20') => ({
    accountId: ACCOUNT,
    syncRunId: 'run',
    month: '2025-03',
    project,
    email,
    resolution: resolveIdentity(roster(), { rawName: '', rawEmail: email, evidenceDate: day }),
  });

  it('does not put counts into the hash, and puts the month into it', () => {
    const a = emitActivityRow(group({ edits: 1 }), ctx('user02@agency.example'));
    const b = emitActivityRow(group({ edits: 99, days: 9 }), ctx('user02@agency.example'));
    expect(a.claimHash).toBe(b.claimHash);
    expect(a.location).not.toBe(b.location);
  });

  it('rejects a group that is outside the month it is emitted for', () => {
    expect(() =>
      emitActivityRow(group({ lastDay: '2025-04-01' }), ctx('user02@agency.example')),
    ).toThrow(/outside its month/);
  });

  it('a non-staff resolution carries its withheld reason', () => {
    const r = emitActivityRow(group(), ctx('someone@client.example'));
    expect(r).toMatchObject({
      personKind: 'external_unresolved',
      withheldReason: 'unresolved',
      staffId: null,
    });
  });
});
