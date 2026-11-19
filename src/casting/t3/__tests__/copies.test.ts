import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRosterIndex, type RosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import {
  COPIES_PER_KEPT_CAP,
  buildCopyIndex,
  decideCopies,
  hasProjectContext,
  type CopyRef,
} from '../copies';
import { MemoryLedger } from '../ledger';
import { formatProposal } from '../proposal';
import { runT3, type T3Deps, type T3Options } from '../run';
import { MemorySink } from '../sink';
import { selectCandidates } from '../triage';
import type { T3Candidate } from '../types';
import { CREDITS_DECK, FakeLlm, FakeReader, GDOC, PDF, answer, cand } from './helpers';
import type { LlmDriver } from '../../../ai/ai.types';

let roster: RosterIndex;
beforeAll(() => {
  roster = buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });
});

const NOW = new Date('2026-11-19T00:00:00Z');
const applyOpts = (over: Partial<T3Options> = {}): T3Options => ({
  mode: 'apply',
  approval: { maxCells: 500, maxCostUsd: 50 },
  policy: { windowStart: '2021-11-19' },
  model: 'gemini-3.5-flash',
  thinkingLevel: 'LOW',
  now: NOW,
  ...over,
});
const dryOpts = (over: Partial<T3Options> = {}): T3Options => ({
  policy: { windowStart: '2021-11-19' },
  model: 'gemini-3.5-flash',
  thinkingLevel: 'LOW',
  now: NOW,
  ...over,
});

const ref = (job: string | null, extra: Partial<NonNullable<T3Candidate['projectRef']>> = {}) => ({
  jobNumber: job,
  campaignId: null,
  pieceId: null,
  ...extra,
});

const KEPT = cand({
  fileId: 'k',
  name: 'Team deck',
  mimeType: PDF,
  md5Checksum: 'm1',
  ancestors: ['P1', 'Brief'],
  accountId: 'acct-A',
  projectRef: ref('J-1'),
  modifiedTime: '2025-06-01T00:00:00Z',
});
const copyOf = (id: string, over: Partial<T3Candidate> = {}): T3Candidate =>
  cand({
    fileId: id,
    name: 'Team deck',
    mimeType: PDF,
    md5Checksum: 'm1',
    ancestors: [`P-${id}`, 'Brief'],
    accountId: 'acct-A',
    projectRef: ref(`J-${id}`),
    modifiedTime: '2025-01-01T00:00:00Z',
    ...over,
  });

const ANSWER = () =>
  answer('credits_or_team', [
    {
      raw_name: 'Jürgen Falkenrath',
      raw_role: 'Creative Director',
      quote: 'Creative Director: Jürgen Falkenrath',
      period_text: '2025',
    },
    {
      raw_name: 'Pavel Orlovsky',
      raw_role: 'VP Marketing',
      quote: 'Client lead: Pavel Orlovsky (VP Marketing, Northwind Foods)',
      is_client_side: true,
    },
  ]);

function setup(
  texts: Record<string, string>,
  extra: {
    ledger?: MemoryLedger;
    sink?: MemorySink;
    contextFor?: T3Deps['contextFor'];
    llm?: FakeLlm;
  } = {},
) {
  const llm = extra.llm ?? new FakeLlm(() => ANSWER());
  const factory = vi.fn(async (): Promise<LlmDriver> => llm);
  const ledger = extra.ledger ?? new MemoryLedger();
  const sink = extra.sink ?? new MemorySink();
  const reader = new FakeReader(texts);
  const deps: T3Deps = {
    reader,
    ledger,
    sink,
    roster,
    llmFactory: factory,
    contextFor: extra.contextFor,
  };
  return { deps, llm, factory, ledger, sink, reader };
}

const rowsOf = (sink: MemorySink, fileId: string) =>
  [...sink.rows.values()].filter((r) => r.file_id === fileId);

describe('decideCopies', () => {
  const mk = (id: string, ok = true): CopyRef => ({
    fileId: id,
    accountId: ok ? 'a' : '',
    createdTime: null,
    projectRef: ref(ok ? `J-${id}` : null),
    docClass: 'pdf',
  });

  it('needs an account and one project reference of the copy itself', () => {
    expect(hasProjectContext(mk('x'))).toBe(true);
    expect(hasProjectContext({ accountId: 'a', projectRef: undefined })).toBe(false);
    expect(hasProjectContext({ accountId: 'a', projectRef: ref(null) })).toBe(false);
    expect(hasProjectContext({ accountId: 'a', projectRef: ref(null, { pieceId: 'p' }) })).toBe(
      true,
    );
    expect(hasProjectContext(mk('x', false))).toBe(false);
  });

  it('sorts by file id, drops the kept file and repeats, and applies the cap', () => {
    const copies = Array.from({ length: COPIES_PER_KEPT_CAP + 5 }, (_, i) =>
      mk(`c-${String(i).padStart(3, '0')}`),
    );
    const d = decideCopies('c-001', [...copies].reverse().concat(copies[3] as CopyRef), 25);
    expect(d.expand).toHaveLength(25);
    expect(d.expand[0]?.fileId).toBe('c-000');
    expect(d.expand.map((c) => c.fileId)).not.toContain('c-001');
    expect(d.overCap.length + d.expand.length).toBe(copies.length - 1);
    expect(d.overCap.map((c) => c.fileId)).toEqual(
      copies
        .slice(26)
        .map((c) => c.fileId)
        .slice(0),
    );
  });

  it('a copy without context never consumes the cap', () => {
    const copies = [mk('a', false), mk('b'), mk('c')];
    const d = decideCopies('k', copies, 1);
    expect(d.withoutContext.map((c) => c.fileId)).toEqual(['a']);
    expect(d.expand.map((c) => c.fileId)).toEqual(['b']);
    expect(d.overCap.map((c) => c.fileId)).toEqual(['c']);
  });

  it('default cap is 25', () => {
    expect(COPIES_PER_KEPT_CAP).toBe(25);
  });
});

describe('selection: only identical content is a copy', () => {
  it('md5 copies are kept as copies of the newest file; version families are only dropped', () => {
    const v1 = cand({
      fileId: 'v1',
      name: 'Staffing v1',
      ancestors: ['P9'],
      modifiedTime: '2024-01-01T00:00:00Z',
    });
    const v2 = cand({
      fileId: 'v2',
      name: 'Staffing v2',
      ancestors: ['P9'],
      modifiedTime: '2024-02-01T00:00:00Z',
    });
    const sel = selectCandidates([KEPT, copyOf('c1'), copyOf('c2'), v1, v2], {
      windowStart: '2021-11-19',
    });
    expect(sel.selected.map((s) => s.candidate.fileId).sort()).toEqual(['k', 'v2']);
    expect(
      sel.copiesOf
        .get('k')
        ?.map((s) => s.candidate.fileId)
        .sort(),
    ).toEqual(['c1', 'c2']);
    expect(sel.copiesOf.has('v2')).toBe(false);
    expect(sel.duplicateOf.get('v1')).toBe('v2');
    expect(sel.excluded.duplicate_md5).toBe(2);
    expect(sel.excluded.duplicate_version_family).toBe(1);
  });

  it('a copy in another folder of an older version still survives its own family', () => {
    // k is the newest of its family P1; the copy sits alone in P2 and is expanded from k.
    const older = cand({
      fileId: 'k-old',
      name: 'Team deck v1',
      mimeType: PDF,
      md5Checksum: 'm0',
      ancestors: ['P1', 'Brief'],
      modifiedTime: '2024-01-01T00:00:00Z',
    });
    const sel = selectCandidates([older, KEPT, copyOf('c1')], { windowStart: '2021-11-19' });
    expect(sel.selected.map((s) => s.candidate.fileId)).toEqual(['k']);
    expect(sel.copiesOf.get('k')?.map((s) => s.candidate.fileId)).toEqual(['c1']);
  });
});

describe('apply: expansion of identical-content copies', () => {
  it('runs the model once and emits rows for every copy, with the copy file and project', async () => {
    const copyB = copyOf('c1', { accountId: 'acct-B' });
    const copyA = copyOf('c2', { projectRef: ref('J-c2', { campaignId: 'camp-9' }) });
    const { deps, llm, reader, ledger, sink } = setup({ k: CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [KEPT, copyB, copyA]);

    expect(llm.calls).toHaveLength(1);
    expect(reader.reads).toEqual(['k']); // copies are never read
    expect(report.run?.usage[0]).toMatchObject({ calls: 1 });
    expect(report.run?.copies).toMatchObject({
      expanded: 2,
      rows: 4,
      copy_without_context: 0,
      overCap: 0,
      foundAtReadTime: 0,
      costUsd: 0,
    });
    expect(report.run?.copies.byAccountClass).toEqual([
      { accountId: 'acct-A', docClass: 'pdf', expanded: 1 },
      { accountId: 'acct-B', docClass: 'pdf', expanded: 1 },
    ]);
    expect(report.run?.costUsd).toBeCloseTo((1000 * 1.5 + 150 * 9) / 1e6, 4);

    const rows = [...sink.rows.values()];
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.claim_hash)).size).toBe(6);
    const sig = (id: string) =>
      rowsOf(sink, id)
        .map((r) => [r.raw_name, r.role_raw, r.quote, r.period_start, r.period_end, r.location])
        .sort();
    expect(sig('c1')).toEqual(sig('k'));
    expect(sig('c2')).toEqual(sig('k'));
    const own = (id: string) => rowsOf(sink, id)[0];
    expect(own('k')).toMatchObject({ account_id: 'acct-A', job_number: 'J-1', campaign_id: null });
    expect(own('c1')).toMatchObject({ account_id: 'acct-B', job_number: 'J-c1' });
    expect(own('c2')).toMatchObject({
      account_id: 'acct-A',
      job_number: 'J-c2',
      campaign_id: 'camp-9',
    });
    expect(rows.every((r) => r.source === 'drive_content')).toBe(true);

    const lines = ledger.records.filter((r) => r.status === 'copy');
    expect(lines.map((l) => l.reason)).toEqual(['md5_copy', 'md5_copy']);
    const keptKey = ledger.records.find((r) => r.status === 'ok')?.cellKey;
    expect(lines.every((l) => l.copyOfCellKey === keptKey)).toBe(true);
  });

  it('resolves each copy with its own account gate', async () => {
    const copyB = copyOf('c1', { accountId: 'acct-B' });
    const copyA = copyOf('c2');
    const { deps, sink } = setup(
      { k: CREDITS_DECK },
      {
        contextFor: (account) => ({
          account: { linkedStaffIds: new Set(account === 'acct-A' ? ['staff-05'] : ['staff-01']) },
        }),
      },
    );
    await runT3(applyOpts(), deps, [KEPT, copyB, copyA]);
    const juergen = (id: string) =>
      rowsOf(sink, id).find((r) => r.raw_name === 'Jürgen Falkenrath');
    expect(juergen('k')).toMatchObject({ person_kind: 'staff', staff_id: 'staff-05' });
    expect(juergen('c2')).toMatchObject({ person_kind: 'staff', staff_id: 'staff-05' });
    expect(juergen('c1')).toMatchObject({
      person_kind: 'quarantined',
      staff_id: null,
      withheld_reason: 'ambiguous',
    });
  });

  it("resolves each copy with its own evidence date (the copy's createdTime)", async () => {
    const llm = new FakeLlm(() =>
      answer('credits_or_team', [
        { raw_name: 'Yuriy Kovalenko', raw_role: 'Producer', quote: 'Producer: Yuriy Kovalenko' },
      ]),
    );
    // staff-07 started 2021-01-11. Kept file created 2025; the copy was created in 2019.
    const copy = copyOf('c1', { createdTime: '2019-06-01T00:00:00Z' });
    const { deps, sink } = setup({ k: CREDITS_DECK }, { llm });
    const report = await runT3(applyOpts(), deps, [KEPT, copy]);
    expect(rowsOf(sink, 'k')[0]).toMatchObject({ person_kind: 'staff', staff_id: 'staff-07' });
    expect(rowsOf(sink, 'c1')[0]).toMatchObject({ person_kind: 'quarantined', staff_id: null });
    expect(report.run?.resolve.byReason).toEqual({ window_gate: 1 });
  });

  it('never expands a version family: only the newest file is processed and gets rows', async () => {
    const v1 = cand({
      fileId: 'v1',
      name: 'Staffing v1',
      ancestors: ['P9'],
      projectRef: ref('J-9'),
      modifiedTime: '2024-01-01T00:00:00Z',
    });
    const v2 = cand({
      fileId: 'v2',
      name: 'Staffing v2',
      ancestors: ['P9'],
      projectRef: ref('J-9'),
      modifiedTime: '2024-02-01T00:00:00Z',
    });
    const { deps, llm, reader, sink, ledger } = setup({ v1: 'old text', v2: CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [v1, v2]);
    expect(reader.reads).toEqual(['v2']);
    expect(llm.calls).toHaveLength(1);
    expect(rowsOf(sink, 'v1')).toHaveLength(0);
    expect(rowsOf(sink, 'v2').length).toBeGreaterThan(0);
    expect(report.run?.copies).toMatchObject({ expanded: 0, rows: 0 });
    expect(ledger.records.some((r) => r.status === 'copy')).toBe(false);
    expect(report.plan.copies.expanded).toBe(0);
  });

  it('a copy with no usable project context emits nothing and never borrows the kept project', async () => {
    const noRef = copyOf('c-noref', { projectRef: undefined });
    const noJob = copyOf('c-nojob', { projectRef: ref(null) });
    const noAccount = copyOf('c-noacct', { accountId: '' });
    const good = copyOf('c-good');
    const { deps, sink } = setup({ k: CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [KEPT, noRef, noJob, noAccount, good]);
    expect(report.run?.copies).toMatchObject({ expanded: 1, copy_without_context: 3, rows: 2 });
    for (const id of ['c-noref', 'c-nojob', 'c-noacct']) expect(rowsOf(sink, id)).toHaveLength(0);
    expect(rowsOf(sink, 'c-good').every((r) => r.job_number === 'J-c-good')).toBe(true);
    expect(
      [...sink.rows.values()].filter((r) => r.job_number === 'J-1').every((r) => r.file_id === 'k'),
    ).toBe(true);
  });

  it('caps copies per kept file and counts the overflow', async () => {
    const many = Array.from({ length: COPIES_PER_KEPT_CAP + 5 }, (_, i) =>
      copyOf(`c-${String(i).padStart(3, '0')}`),
    );
    const { deps, sink, llm } = setup({ k: CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [KEPT, ...many]);
    expect(llm.calls).toHaveLength(1);
    expect(report.run?.copies).toMatchObject({ expanded: 25, overCap: 5, rows: 50 });
    expect(rowsOf(sink, 'c-024').length).toBe(2);
    expect(rowsOf(sink, 'c-025')).toHaveLength(0);
    expect(rowsOf(sink, 'c-029')).toHaveLength(0);
    expect(report.plan.copies).toMatchObject({ expanded: 25, overCap: 5, candidates: 30 });
  });

  it('copies found at read time (same text, different md5 or a native document) are expanded too', async () => {
    const g1 = cand({ fileId: 'g1', name: 'Team doc', ancestors: ['P1'], projectRef: ref('J-g1') });
    const g2 = cand({ fileId: 'g2', name: 'Team doc', ancestors: ['P2'], projectRef: ref('J-g2') });
    const { deps, llm, sink, ledger } = setup({ g1: CREDITS_DECK, g2: CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [g1, g2]);
    expect(llm.calls).toHaveLength(1);
    expect(report.run?.copies).toMatchObject({ foundAtReadTime: 1, expanded: 1, rows: 2 });
    expect(rowsOf(sink, 'g2').map((r) => r.job_number)).toEqual(['J-g2', 'J-g2']);
    expect(ledger.records.find((r) => r.status === 'copy')?.reason).toBe('content_copy');
  });

  it('md5 copies of a read-time copy follow it to the kept file', async () => {
    const mk = (id: string, md5: string, folder: string): T3Candidate =>
      cand({
        fileId: id,
        name: 'Team deck',
        mimeType: PDF,
        md5Checksum: md5,
        ancestors: [folder],
        projectRef: ref(`J-${id}`),
      });
    const { deps, llm, sink } = setup({ k1: CREDITS_DECK, k2: CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [
      mk('k1', 'a', 'P1'),
      mk('k2', 'b', 'P2'),
      mk('k2c', 'b', 'P3'),
    ]);
    expect(llm.calls).toHaveLength(1);
    expect(report.run?.copies).toMatchObject({ foundAtReadTime: 1, expanded: 2 });
    for (const id of ['k1', 'k2', 'k2c']) expect(rowsOf(sink, id).length).toBeGreaterThan(0);
  });

  it('a failed kept file yields no rows for its copies', async () => {
    const llm = new FakeLlm(() => {
      throw new Error('503 upstream');
    });
    const { deps, sink } = setup({ k: CREDITS_DECK }, { llm });
    const report = await runT3(applyOpts(), deps, [KEPT, copyOf('c1')]);
    expect(report.run).toMatchObject({ failed: 1 });
    expect(sink.rows.size).toBe(0);
    expect(report.run?.copies.expanded).toBe(0);
  });
});

describe('resume and idempotency', () => {
  it('a resumed run expands the same set, writes nothing new and adds no ledger lines', async () => {
    const first = setup({ k: CREDITS_DECK });
    await runT3(applyOpts(), first.deps, [KEPT, copyOf('c1'), copyOf('c2')]);
    const rows = first.sink.rows.size;
    const lines = first.ledger.records.length;
    expect(rows).toBe(6);

    const idle = new FakeLlm(() => {
      throw new Error('must not be called on resume');
    });
    const second = setup({}, { ledger: first.ledger, sink: first.sink, llm: idle });
    const report = await runT3(applyOpts(), second.deps, [KEPT, copyOf('c1'), copyOf('c2')]);
    expect(idle.calls).toHaveLength(0);
    expect(second.reader.reads).toEqual([]);
    expect(report.run).toMatchObject({ attempted: 0, rowsInserted: 0, rowsDuplicate: rows });
    expect(report.run?.copies).toMatchObject({ expanded: 2, rows: 4 });
    expect(first.sink.rows.size).toBe(rows);
    expect(first.ledger.records).toHaveLength(lines);
  });

  it('the ledger alone carries the mapping: a resume that no longer lists a copy still expands it', async () => {
    const first = setup({ k: CREDITS_DECK });
    await runT3(applyOpts(), first.deps, [KEPT, copyOf('c1'), copyOf('c2')]);
    const second = setup({}, { ledger: first.ledger, sink: first.sink });
    const report = await runT3(applyOpts(), second.deps, [KEPT]);
    expect(report.run?.copies.expanded).toBe(2);
    expect(report.run?.rowsInserted).toBe(0);
  });

  it('a copy that appears later is recorded and expanded; nothing else is written twice', async () => {
    const first = setup({ k: CREDITS_DECK });
    await runT3(applyOpts(), first.deps, [KEPT, copyOf('c1')]);
    expect(first.sink.rows.size).toBe(4);
    const second = setup({}, { ledger: first.ledger, sink: first.sink });
    const report = await runT3(applyOpts(), second.deps, [KEPT, copyOf('c1'), copyOf('c2')]);
    expect(second.llm.calls).toHaveLength(0);
    expect(report.run).toMatchObject({ rowsInserted: 2, rowsDuplicate: 4 });
    expect(first.ledger.records.filter((r) => r.status === 'copy')).toHaveLength(2);
    expect(first.sink.rows.size).toBe(6);
  });

  it('buildCopyIndex ignores copy lines it cannot attach and breaks cycles', () => {
    const line = (cellKey: string, of: string, id: string) =>
      ({
        v: 1,
        cellKey,
        extractorVersion: 'x',
        at: '',
        status: 'copy',
        reason: 'content_copy',
        copyOfCellKey: of,
        candidate: { fileId: id, accountId: 'a', createdTime: null, projectRef: ref('J') },
        docClass: 'pdf',
        contentHash: null,
        docType: null,
        truncated: false,
        sentChars: null,
        attempts: 0,
        usage: null,
        mentions: [],
        sanitizeStats: null,
        groundingStats: null,
      }) as const;
    const idx = buildCopyIndex([line('a', 'b', 'fa'), line('b', 'a', 'fb')], []);
    expect(
      [...idx.values()]
        .flat()
        .map((c) => c.fileId)
        .sort(),
    ).toEqual(['fa', 'fb']);
  });
});

describe('dry-run planner and estimate', () => {
  const files = () => [
    { ...KEPT, approxChars: 12_000 },
    copyOf('c1'),
    copyOf('c2', { accountId: 'acct-B' }),
    copyOf('c3', { projectRef: undefined }),
  ];

  it('reports documents to read separately from copies expanded, and writes nothing', async () => {
    const { deps, factory, ledger, sink, reader } = setup({});
    const report = await runT3(dryOpts(), deps, files());
    expect(report.plan).toMatchObject({ selected: 1, documentsToRead: 1, cellsToRun: 1 });
    expect(report.plan.copies).toMatchObject({
      candidates: 3,
      expanded: 2,
      expandedForCellsToRun: 2,
      copy_without_context: 1,
      overCap: 0,
    });
    expect(report.plan.copies.byAccountClass).toEqual([
      { accountId: 'acct-A', docClass: 'pdf', expanded: 1 },
      { accountId: 'acct-B', docClass: 'pdf', expanded: 1 },
    ]);
    expect(factory).not.toHaveBeenCalled();
    expect(reader.reads).toEqual([]);
    expect(ledger.records).toHaveLength(0);
    expect(sink.runs).toHaveLength(0);
  });

  it('prices only the documents the model reads; copies are shown as expanded at $0', async () => {
    const withCopies = await runT3(dryOpts(), setup({}).deps, files());
    const without = await runT3(dryOpts(), setup({}).deps, [{ ...KEPT, approxChars: 12_000 }]);
    for (let i = 0; i < withCopies.estimates.length; i++) {
      const a = withCopies.estimates[i];
      const b = without.estimates[i];
      expect(a?.base.costUsd).toBe(b?.base.costUsd);
      expect(a?.base).toMatchObject({ expandedCopies: 2, expandedCostUsd: 0, cells: 1 });
      expect(b?.base.expandedCopies).toBe(0);
    }
  });

  it('the proposal text carries the copy counts per account and class', async () => {
    const report = await runT3(dryOpts(), setup({}).deps, files());
    const text = formatProposal({
      cells: report.plan.documentsToRead,
      accounts: 'one',
      thinkingLevel: 'LOW',
      parallel: 2,
      estimates: report.estimates,
      copies: {
        documentsToRead: report.plan.documentsToRead,
        expanded: report.plan.copies.expandedForCellsToRun,
        withoutContext: report.plan.copies.copy_without_context,
        overCap: report.plan.copies.overCap,
        byAccountClass: report.plan.copies.byAccountClass,
      },
    });
    expect(text).toContain('documents to read: 1   copies expanded, no model call, $0: 2');
    expect(text).toContain('copy_without_context 1, over cap 0');
    expect(text).toContain('copies expanded: acct-B / pdf: 1');
  });

  it('a dry-run over a filled ledger previews the rows including copies, with no model call', async () => {
    const first = setup({ k: CREDITS_DECK });
    await runT3(applyOpts(), first.deps, [KEPT, copyOf('c1'), copyOf('c2')]);
    const idle = new FakeLlm(() => {
      throw new Error('must not be called');
    });
    const second = setup({}, { ledger: first.ledger, llm: idle });
    const report = await runT3(dryOpts(), second.deps, [KEPT, copyOf('c1'), copyOf('c2')]);
    expect(report.plan).toMatchObject({ documentsToRead: 0, cellsAlreadyDone: 1 });
    expect(report.resolvePreview?.copies).toMatchObject({ expanded: 2, rows: 4 });
    expect(report.resolvePreview?.mentions).toBe(6);
    expect(idle.calls).toHaveLength(0);
    expect(second.factory).not.toHaveBeenCalled();
  });

  it('an over-cap template is visible in the plan before anything runs', async () => {
    const many = Array.from({ length: 40 }, (_, i) => copyOf(`c-${String(i).padStart(3, '0')}`));
    const report = await runT3(dryOpts(), setup({}).deps, [
      { ...KEPT, approxChars: 5000 },
      ...many,
    ]);
    expect(report.plan.copies).toMatchObject({ expanded: 25, overCap: 15 });
  });
});

describe('gdoc fixture sanity', () => {
  it('native documents have no md5: only read-time copies apply to them', () => {
    const a = cand({ fileId: 'a', name: 'Team doc', mimeType: GDOC, ancestors: ['P1'] });
    const b = cand({ fileId: 'b', name: 'Team doc', mimeType: GDOC, ancestors: ['P2'] });
    const sel = selectCandidates([a, b], { windowStart: '2021-11-19' });
    expect(sel.selected).toHaveLength(2);
    expect(sel.copiesOf.size).toBe(0);
  });
});
