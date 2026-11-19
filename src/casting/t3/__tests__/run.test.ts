import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRosterIndex, type RosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import { MemoryLedger } from '../ledger';
import { promptOverheadChars } from '../prompt';
import { runT3, type T3Deps, type T3Options } from '../run';
import { MemorySink } from '../sink';
import { T3_CALL_TAG } from '../types';
import {
  ACCOUNT,
  CREDITS_DECK,
  FakeLlm,
  FakeReader,
  GSLIDES,
  answer,
  cand,
  usage,
} from './helpers';
import type { LlmDriver } from '../../../ai/ai.types';

let roster: RosterIndex;
beforeAll(() => {
  roster = buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });
});

const NOW = new Date('2026-11-19T00:00:00Z');

const baseOpts = (over: Partial<T3Options> = {}): T3Options => ({
  policy: { windowStart: '2021-11-19' },
  model: 'gemini-3.5-flash',
  thinkingLevel: 'LOW',
  now: NOW,
  ...over,
});
const applyOpts = (over: Partial<T3Options> = {}): T3Options =>
  baseOpts({ mode: 'apply', approval: { maxCells: 50, maxCostUsd: 5 }, ...over });

const DECK = cand({
  fileId: 'file-deck',
  name: 'Spring Launch Team and Credits',
  mimeType: GSLIDES,
  ancestors: ['Projects', 'Spring Launch'],
  projectRef: { jobNumber: 'JOB-1001', campaignId: null, pieceId: null },
});
const STATUS = cand({
  fileId: 'file-status',
  name: 'Weekly Status Report',
  ancestors: ['Projects', 'Spring Launch'],
});

const DECK_ANSWER = () =>
  answer('credits_or_team', [
    {
      raw_name: 'Jürgen Falkenrath',
      raw_role: 'Creative Director',
      quote: 'Creative Director: Jürgen Falkenrath',
    },
    {
      raw_name: 'Zofia Marek-Lindqvist',
      raw_role: 'Senior Copywriter',
      quote: 'Senior Copywriter: Zofia Marek-Lindqvist',
      period_text: '2025',
    },
    { raw_name: 'Yuriy Kovalenko', raw_role: 'Producer', quote: 'Producer: Yuriy Kovalenko' },
    {
      raw_name: 'Pavel Orlovsky',
      raw_role: 'VP Marketing',
      quote: 'Client lead: Pavel Orlovsky (VP Marketing, Northwind Foods)',
      is_client_side: true,
    },
    { raw_name: 'Nobody Here', raw_role: 'Director', quote: 'Director: Nobody Here' },
  ]);

function setup(
  llm: FakeLlm,
  texts: Record<string, string>,
  extra: { ledger?: MemoryLedger; sink?: MemorySink; reader?: FakeReader } = {},
) {
  const factory = vi.fn(async (): Promise<LlmDriver> => llm);
  const ledger = extra.ledger ?? new MemoryLedger();
  const sink = extra.sink ?? new MemorySink();
  const reader = extra.reader ?? new FakeReader(texts);
  const deps: T3Deps = { reader, ledger, sink, roster, llmFactory: factory };
  return { deps, factory, ledger, sink, reader };
}

const STATUS_TEXT = 'Weekly status: Jürgen Falkenrath (Creative Director) approved the boards.';

describe('dry-run (the default)', () => {
  it('plans and estimates without a model, a sink write or a ledger write', async () => {
    const llm = new FakeLlm(() => {
      throw new Error('must not be called');
    });
    const { deps, factory, ledger, sink } = setup(llm, {});
    const files = [
      { ...DECK, approxChars: 12_000 },
      { ...STATUS, approxChars: 3000 },
      cand({ fileId: 'inv', name: 'Invoice 7', ancestors: ['Finance'] }),
    ];
    const report = await runT3(baseOpts(), deps, files);
    expect(report.mode).toBe('dry-run');
    expect(report.plan).toMatchObject({
      candidates: 3,
      selected: 2,
      cellsToRun: 2,
      cellsAlreadyDone: 0,
    });
    expect(report.plan.excluded.hard_noise).toBe(1);
    expect(report.estimates.map((e) => e.model)).toEqual([
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(report.sizedCells).toBe(2);
    expect(report.run).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
    expect(ledger.records).toHaveLength(0);
    expect(sink.runs).toHaveLength(0);
    expect(sink.rows.size).toBe(0);
  });

  it('with readText it reads documents to size the estimate, still no model', async () => {
    const llm = new FakeLlm(() => {
      throw new Error('must not be called');
    });
    const { deps, factory, reader } = setup(llm, { 'file-deck': CREDITS_DECK });
    const report = await runT3(baseOpts({ readText: true }), deps, [DECK, STATUS]);
    expect(reader.reads.sort()).toEqual(['file-deck', 'file-status']);
    expect(report.plan.readSkips).toEqual({ empty: 1 });
    expect(report.sizedCells).toBe(1);
    expect(report.unsizedCells).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it('a read error in dry-run is counted, not thrown', async () => {
    const llm = new FakeLlm(() => answer('other', []));
    const { deps, factory } = setup(llm, {
      'file-deck': new Error('403 cannotDownloadFile') as never,
    });
    const report = await runT3(baseOpts({ readText: true }), deps, [DECK]);
    expect(report.plan.readSkips).toEqual({ read_error: 1 });
    expect(report.sizedCells).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it('flags an estimate as incomplete when cells have no length', async () => {
    const llm = new FakeLlm(() => answer('other', []));
    const { deps } = setup(llm, {});
    const report = await runT3(baseOpts(), deps, [DECK]);
    expect(report.unsizedCells).toBe(1);
    expect(report.estimates[0]?.base.complete).toBe(false);
  });
});

describe('apply guards', () => {
  const llm = () => new FakeLlm(() => answer('other', []));

  it('is not reachable without an approval; the client is never built', async () => {
    const { deps, factory, sink } = setup(llm(), {});
    await expect(runT3(baseOpts({ mode: 'apply' }), deps, [DECK])).rejects.toThrow(/approval/);
    await expect(
      runT3(baseOpts({ mode: 'apply', approval: { maxCells: 0, maxCostUsd: 1 } }), deps, [DECK]),
    ).rejects.toThrow(/approval/);
    await expect(
      runT3(baseOpts({ mode: 'apply', approval: { maxCells: 5, maxCostUsd: 0 } }), deps, [DECK]),
    ).rejects.toThrow(/approval/);
    expect(factory).not.toHaveBeenCalled();
    expect(sink.runs).toHaveLength(0);
  });

  it('refuses a model with no price and a parallelism above 2', async () => {
    const { deps, factory } = setup(llm(), {});
    await expect(runT3(applyOpts({ model: 'unpriced-model' }), deps, [DECK])).rejects.toThrow(
      /priced model/,
    );
    await expect(runT3(applyOpts({ parallel: 3 }), deps, [DECK])).rejects.toThrow(/parallel/);
    await expect(runT3(baseOpts({ parallel: 3 }), deps, [DECK])).rejects.toThrow(/parallel/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('refuses to start when the plan is larger than the approved cell count', async () => {
    const { deps, factory, sink, ledger } = setup(llm(), {});
    await expect(
      runT3(applyOpts({ approval: { maxCells: 1, maxCostUsd: 5 } }), deps, [DECK, STATUS]),
    ).rejects.toThrow(/above the approved 1/);
    expect(factory).not.toHaveBeenCalled();
    expect(sink.runs).toHaveLength(0);
    expect(ledger.records).toHaveLength(0);
  });
});

describe('apply with a fake model', () => {
  it('extracts, grounds, resolves through S3 and writes Layer 1 rows with per-tag accounting', async () => {
    const llm = new FakeLlm((req) => {
      if (req.prompt.includes('Spring Launch: team')) return DECK_ANSWER();
      return answer(
        'status_or_timing',
        [
          {
            raw_name: 'Jürgen Falkenrath',
            raw_role: 'Creative Director',
            quote: 'Jürgen Falkenrath (Creative Director)',
          },
        ],
        usage(500, 80, 20),
      );
    });
    const { deps, factory, sink, ledger } = setup(llm, {
      'file-deck': CREDITS_DECK,
      'file-status': STATUS_TEXT,
    });
    const report = await runT3(applyOpts(), deps, [DECK, STATUS]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(report.run).toMatchObject({
      status: 'success',
      attempted: 2,
      ok: 2,
      failed: 0,
      skipped: 0,
    });

    // request hygiene: tag, thinking level, flat schema, no ids or account in the prompt
    for (const req of llm.calls) {
      expect(req.tag).toBe(T3_CALL_TAG);
      expect(req.thinkingLevel).toBe('LOW');
      expect(req.responseSchema).toBeDefined();
      expect(req.prompt).not.toContain('file-deck');
      expect(req.prompt).not.toContain('file-status');
      expect(req.prompt).not.toContain(ACCOUNT);
      expect(req.prompt).not.toContain('JOB-1001');
    }

    // per-tag accounting from the fake's reported usage
    const row = report.run?.usage[0];
    expect(row).toMatchObject({
      tag: T3_CALL_TAG,
      calls: 2,
      promptTokens: 1500,
      outputTokens: 180,
      thoughtsTokens: 70,
    });
    expect(report.run?.costUsd).toBeCloseTo((1500 * 1.5 + 250 * 9) / 1e6, 6);
    expect(report.run?.driverAttempts).toEqual([]);

    // quality counters: 'Nobody Here' is not in the document
    expect(report.run?.quality).toMatchObject({
      cellsFirstTryValid: 2,
      droppedUngroundedName: 1,
      mentionsKept: 5,
    });

    // rows
    const rows = [...sink.rows.values()];
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['drive_content']));
    expect(new Set(rows.map((r) => r.sync_run_id))).toEqual(new Set(['run-1']));
    const byName = (n: string, f = 'file-deck') =>
      rows.find((r) => r.raw_name === n && r.file_id === f);
    expect(byName('Jürgen Falkenrath')).toMatchObject({
      person_kind: 'staff',
      staff_id: 'staff-05',
      role_norm: 'creative_director',
      job_number: 'JOB-1001',
      account_id: ACCOUNT,
      location: 'slide 2',
      withheld_reason: null,
    });
    expect(byName('Jürgen Falkenrath', 'file-status')).toMatchObject({ staff_id: 'staff-05' });
    expect(byName('Zofia Marek-Lindqvist')).toMatchObject({
      role_norm: 'copywriter',
      seniority: 'senior',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    });
    expect(byName('Yuriy Kovalenko')).toMatchObject({ person_kind: 'staff', staff_id: 'staff-07' });
    expect(byName('Pavel Orlovsky')).toMatchObject({
      person_kind: 'external_unresolved',
      staff_id: null,
      withheld_reason: 'unresolved',
      confidence: 0,
    });
    expect(rows.every((r) => r.extractor_version === 't3-v1:gemini-3.5-flash:low')).toBe(true);
    expect(rows.every((r) => (r.quote ?? '').length <= 300)).toBe(true);
    expect(report.run?.resolve.byKind).toEqual({
      staff: 4,
      external_unresolved: 1,
      quarantined: 0,
    });
    expect(report.run?.resolve.byReason).toEqual({ client_side: 1 });

    // finishRun, ledger
    expect(sink.runs[0]).toMatchObject({ status: 'success' });
    expect(ledger.records.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(ledger.records[0]?.usage).not.toBeNull();
  });

  it('resumes from the ledger: no second model call, and re-applying writes nothing new', async () => {
    const llm = new FakeLlm(() => DECK_ANSWER());
    const first = setup(llm, { 'file-deck': CREDITS_DECK });
    await runT3(applyOpts(), first.deps, [DECK]);
    expect(llm.calls).toHaveLength(1);
    const rowsBefore = first.sink.rows.size;

    const llm2 = new FakeLlm(() => {
      throw new Error('must not be called on resume');
    });
    const second = setup(
      llm2,
      { 'file-deck': CREDITS_DECK },
      { ledger: first.ledger, sink: first.sink },
    );
    const report = await runT3(applyOpts(), second.deps, [DECK]);
    expect(llm2.calls).toHaveLength(0);
    expect(report.plan).toMatchObject({ cellsAlreadyDone: 1, cellsToRun: 0 });
    expect(report.run).toMatchObject({ attempted: 0, rowsInserted: 0, rowsDuplicate: rowsBefore });
    expect(first.sink.rows.size).toBe(rowsBefore);
  });

  it('a different thinking level or model is a new cell, not a resume', async () => {
    const llm = new FakeLlm(() => DECK_ANSWER());
    const a = setup(llm, { 'file-deck': CREDITS_DECK });
    await runT3(applyOpts(), a.deps, [DECK]);
    const b = setup(llm, { 'file-deck': CREDITS_DECK }, { ledger: a.ledger, sink: a.sink });
    const report = await runT3(applyOpts({ thinkingLevel: 'MINIMAL' }), b.deps, [DECK]);
    expect(report.plan.cellsToRun).toBe(1);
    expect(llm.calls).toHaveLength(2);
    expect(new Set([...a.sink.rows.values()].map((r) => r.extractor_version))).toEqual(
      new Set(['t3-v1:gemini-3.5-flash:low', 't3-v1:gemini-3.5-flash:minimal']),
    );
  });

  it('sends identical content once and records the copy as skipped', async () => {
    const llm = new FakeLlm(() => DECK_ANSWER());
    const copy = cand({
      fileId: 'file-copy',
      name: 'Copy of the credits',
      mimeType: GSLIDES,
      ancestors: ['Elsewhere', 'Team'],
    });
    const { deps, ledger } = setup(llm, { 'file-deck': CREDITS_DECK, 'file-copy': CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [DECK, copy]);
    expect(llm.calls).toHaveLength(1);
    expect(report.run).toMatchObject({ attempted: 1, ok: 1, skipped: 1 });
    expect(ledger.records.find((r) => r.status === 'skipped')?.reason).toBe('duplicate_content');
  });

  it('retries one invalid answer once, bills both attempts, and counts the retry', async () => {
    const llm = new FakeLlm((_req, n) =>
      n === 1
        ? { text: 'oops not json', driver: 'fake', model: 'fake', usage: usage(1000, 5, 0) }
        : DECK_ANSWER(),
    );
    const { deps } = setup(llm, { 'file-deck': CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [DECK]);
    expect(llm.calls).toHaveLength(2);
    expect(report.run?.quality).toMatchObject({ cellsRetried: 1, cellsFirstTryValid: 0 });
    expect(report.run?.usage[0]).toMatchObject({ calls: 2, promptTokens: 2000 });
    expect(report.run?.ok).toBe(1);
  });

  it('fails a cell after two invalid answers and does not re-bill it on resume unless asked', async () => {
    const llm = new FakeLlm(() => ({
      text: '{"doc_type":"other"}',
      driver: 'fake',
      model: 'fake',
      usage: usage(),
    }));
    const first = setup(llm, { 'file-deck': CREDITS_DECK });
    const report = await runT3(applyOpts(), first.deps, [DECK]);
    expect(llm.calls).toHaveLength(2);
    expect(report.run).toMatchObject({ failed: 1, ok: 0 });
    expect(report.run?.quality.cellsSchemaFailed).toBe(1);
    expect(first.ledger.records[0]).toMatchObject({ status: 'failed', attempts: 2 });
    expect(first.ledger.records[0]?.reason).toContain('schema_invalid');

    const again = setup(
      llm,
      { 'file-deck': CREDITS_DECK },
      { ledger: first.ledger, sink: first.sink },
    );
    await runT3(applyOpts(), again.deps, [DECK]);
    expect(llm.calls).toHaveLength(2);
    const forced = setup(
      llm,
      { 'file-deck': CREDITS_DECK },
      { ledger: first.ledger, sink: first.sink },
    );
    await runT3(applyOpts({ retryFailed: true }), forced.deps, [DECK]);
    expect(llm.calls).toHaveLength(4);
  });

  it('records a model error as a failed cell and carries on with the others', async () => {
    const llm = new FakeLlm((req) => {
      if (req.prompt.includes('Spring Launch: team')) throw new Error('503 upstream');
      return answer('status_or_timing', []);
    });
    const { deps, ledger } = setup(llm, { 'file-deck': CREDITS_DECK, 'file-status': STATUS_TEXT });
    const report = await runT3(applyOpts(), deps, [DECK, STATUS]);
    expect(report.run).toMatchObject({ attempted: 2, ok: 1, failed: 1 });
    expect(ledger.records.find((r) => r.status === 'failed')?.reason).toContain('503 upstream');
  });

  it('records a read failure without calling the model', async () => {
    const llm = new FakeLlm(() => answer('other', []));
    const { deps, ledger } = setup(llm, {
      'file-deck': new Error('403 cannotDownloadFile') as never,
    });
    const report = await runT3(applyOpts(), deps, [DECK]);
    expect(llm.calls).toHaveLength(0);
    expect(report.run).toMatchObject({ failed: 1 });
    expect(ledger.records[0]?.reason).toContain('read_error');
  });

  it('stops launching cells once the approved spend is reached, and says so', async () => {
    // Each call costs (1,000,000 x 1.5 + 0) / 1e6 = 1.5 USD
    const llm = new FakeLlm(() => answer('other', [], usage(1_000_000, 0, 0)));
    const files = ['a', 'b', 'c', 'd'].map((x) =>
      cand({ fileId: `f-${x}`, name: 'Team', ancestors: [x] }),
    );
    const texts = Object.fromEntries(files.map((f) => [f.fileId, `Team document ${f.fileId}`]));
    const { deps, sink } = setup(llm, texts);
    const report = await runT3(
      applyOpts({ approval: { maxCells: 10, maxCostUsd: 2 } }),
      deps,
      files,
    );
    expect(llm.calls).toHaveLength(2);
    expect(report.run).toMatchObject({
      status: 'stopped',
      stoppedReason: 'budget',
      attempted: 2,
      deferred: 2,
    });
    expect(sink.runs[0]).toMatchObject({ status: 'stopped' });
    expect(report.run?.costUsd).toBeCloseTo(3, 6);
  });

  it('never has more than 2 calls in flight, and 1 by default', async () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      cand({ fileId: `f-${i}`, name: 'Team', ancestors: [`p${i}`] }),
    );
    const texts = Object.fromEntries(files.map((f) => [f.fileId, `Team document ${f.fileId}`]));
    const par = new FakeLlm(() => answer('other', []), 5);
    await runT3(applyOpts({ parallel: 2 }), setup(par, texts).deps, files);
    expect(par.peak).toBe(2);
    const seq = new FakeLlm(() => answer('other', []), 2);
    await runT3(applyOpts(), setup(seq, texts).deps, files);
    expect(seq.peak).toBe(1);
  });

  it('truncates a long document to the cap and records it', async () => {
    const long = CREDITS_DECK + '\n' + 'filler line of no interest\n'.repeat(3000);
    const llm = new FakeLlm(() => answer('credits_or_team', []));
    const { deps, ledger } = setup(llm, { 'file-deck': long });
    await runT3(applyOpts({ capChars: 5000 }), deps, [DECK]);
    expect(llm.calls[0]?.prompt.length).toBeLessThan(5000 + promptOverheadChars() + 200);
    expect(ledger.records[0]).toMatchObject({ truncated: true });
    expect(ledger.records[0]?.sentChars ?? 0).toBeLessThanOrEqual(5000);
  });

  it('a work period before the person started is quarantined by the window gate, not guessed', async () => {
    const llm = new FakeLlm(() =>
      answer('credits_or_team', [
        {
          raw_name: 'Yuriy Kovalenko',
          raw_role: 'Producer',
          quote: 'Producer: Yuriy Kovalenko',
          period_text: '2018',
        },
      ]),
    );
    const { deps, sink } = setup(llm, { 'file-deck': CREDITS_DECK });
    const report = await runT3(applyOpts(), deps, [DECK]);
    const row = [...sink.rows.values()][0];
    expect(row).toMatchObject({
      person_kind: 'quarantined',
      staff_id: null,
      withheld_reason: 'ambiguous',
    });
    expect(report.run?.resolve.byReason).toEqual({ window_gate: 1 });
  });
});

describe('re-resolution at $0', () => {
  it('a dry-run over a filled ledger re-resolves against a new roster with no model call', async () => {
    const llm = new FakeLlm(() => DECK_ANSWER());
    const first = setup(llm, { 'file-deck': CREDITS_DECK });
    await runT3(applyOpts(), first.deps, [DECK]);
    expect(llm.calls).toHaveLength(1);

    const smaller = buildRosterIndex(
      ROSTER.filter((r) => r.staffId !== 'staff-05'),
      {
        agencyEmailDomains: ['agency.example'],
      },
    );
    const idle = new FakeLlm(() => {
      throw new Error('must not be called');
    });
    const deps2: T3Deps = {
      reader: new FakeReader({}),
      ledger: first.ledger,
      sink: new MemorySink(),
      roster: smaller,
      llmFactory: vi.fn(async () => idle),
    };
    const preview = await runT3(baseOpts(), deps2, [DECK]);
    expect(idle.calls).toHaveLength(0);
    expect(deps2.llmFactory).not.toHaveBeenCalled();
    expect(preview.resolvePreview?.byKind).toEqual({
      staff: 2,
      external_unresolved: 2,
      quarantined: 0,
    });
    expect(preview.resolvePreview?.byReason).toMatchObject({ not_in_roster: 1, client_side: 1 });
  });
});
