/**
 * The ledger loader on synthetic data: ledgers are produced by the pilot driver itself (fake
 * listing, fake reader, fake model, in-memory sink) into a temp directory, then loaded. No test
 * here reaches Drive, a database or a model client. Every name, folder and id is invented.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import { JsonlLedger } from '../ledger';
import { LOAD_BATCH, LOAD_EXIT, runLoad, type LoadIo } from '../load';
import { parseLoadArgs, type LoadArgs } from '../load-args';
import { runLoadCli } from '../load-main';
import { PILOT_HEADER_FILE, runPilot, type PilotIo } from '../pilot';
import { parsePilotArgs } from '../pilot-args';
import type { EvidenceRowShape } from '../row';
import { MemorySink, SinkUnavailableError, type T3Sink } from '../sink';
import { T3_PROMPT_VERSION, type T3Candidate } from '../types';
import { CREDITS_DECK, FakeLlm, GSLIDES, answer, cand } from './helpers';

const ACCT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCT = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-20T00:00:00Z');

let tmp: string;
let repo: string;
let ledgers: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'load-test-'));
  repo = path.join(tmp, 'repo');
  ledgers = path.join(tmp, 'ledgers');
  fs.mkdirSync(repo);
  fs.mkdirSync(ledgers);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const roster = () => buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });

const word = (i: number): string => `q${String.fromCharCode(97 + (i % 26))}${i}`;

/** Three kept slide decks plus one md5 copy of the first (a project folder of its own). */
function candidates(): T3Candidate[] {
  const kept = [0, 1, 2].map((i) =>
    cand({
      fileId: `file-${i}`,
      name: `Review ${word(i)}`,
      mimeType: GSLIDES,
      ancestors: ['root', `Folder ${word(i)}`],
      accountId: ACCT,
      ...(i === 0 ? { md5Checksum: 'md5-x' } : {}),
    }),
  );
  const copy = cand({
    fileId: 'file-copy',
    name: `Review ${word(900)}`,
    mimeType: GSLIDES,
    ancestors: ['root', 'Other [ACME12345678]'],
    accountId: ACCT,
    md5Checksum: 'md5-x',
    projectRef: { jobNumber: 'ACME12345678' },
  });
  return [...kept, copy];
}

const MODEL_ANSWER = () =>
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
    {
      raw_name: 'Pavel Orlovsky',
      raw_role: 'VP Marketing',
      quote: 'Client lead: Pavel Orlovsky (VP Marketing, Northwind Foods)',
      is_client_side: true,
    },
    {
      raw_name: 'Łukasz Wieczorkiewicz',
      raw_role: 'Art Director',
      quote: 'Art Director: Łukasz Wieczorkiewicz',
    },
  ]);

interface PilotRun {
  dir: string;
  /** Rows the stage's own sink received in the pilot run (what the stage resolves from the ledger). */
  stageRows: Map<string, EvidenceRowShape & { sync_run_id: string }>;
}

/** Runs the pilot driver (fake model) into a ledger directory. */
async function makeLedger(name: string, list: readonly T3Candidate[] = candidates()) {
  const dir = path.join(ledgers, name);
  const sink = new MemorySink();
  const io: PilotIo = {
    loadCandidates: async () => list,
    loadRoster: async () => roster(),
    makeReader: () => ({
      async read(c: T3Candidate) {
        return { kind: 'ok' as const, text: `${CREDITS_DECK}\n\nDocument ${c.fileId}` };
      },
    }),
    makeLlm: async () => new FakeLlm(() => MODEL_ANSWER()),
    makeSink: () => sink,
    openLedger: (d) => new JsonlLedger(d, repo),
    repoRoots: [repo],
    print: () => undefined,
    now: NOW,
  };
  const args = parsePilotArgs([
    '--account-id',
    ACCT,
    '--window-start',
    '2021-11-19',
    '--sample-seed',
    'seed-a',
    '--sample-size',
    '10',
    '--apply',
    '--max-cells',
    '10',
    '--max-usd',
    '5',
    '--ledger-dir',
    dir,
  ]);
  await runPilot(args, io);
  const out: PilotRun = { dir, stageRows: sink.rows };
  return out;
}

class RecordingSink implements T3Sink {
  readonly inner = new MemorySink();
  readonly started: { extractorVersion: string; details?: Readonly<Record<string, unknown>> }[] =
    [];
  readonly finished: { status: string; details?: Readonly<Record<string, unknown>> }[] = [];
  readonly batches: number[] = [];
  async startRun(info: { extractorVersion: string; details?: Readonly<Record<string, unknown>> }) {
    this.started.push(info);
    return this.inner.startRun();
  }
  async writeEvidence(id: string, rows: readonly EvidenceRowShape[]) {
    this.batches.push(rows.length);
    return this.inner.writeEvidence(id, rows);
  }
  async finishRun(id: string, outcome: Parameters<T3Sink['finishRun']>[1]): Promise<void> {
    this.finished.push({
      status: outcome.status,
      ...(outcome.details ? { details: outcome.details } : {}),
    });
    return this.inner.finishRun(id, outcome);
  }
}

function loadIo(sink: T3Sink, over: Partial<LoadIo> = {}): LoadIo & { printed: string[] } {
  const printed: string[] = [];
  return {
    loadRoster: async () => roster(),
    makeSink: async () => sink,
    repoRoots: [repo],
    print: (l) => printed.push(l),
    printed,
    ...over,
  };
}

const loadArgs = (dir: string, over: Partial<LoadArgs> = {}): LoadArgs => ({
  mode: 'dry-run',
  ledgerDir: dir,
  accountId: ACCT,
  agencyDomains: [],
  unknownStartDates: [],
  ...over,
});

const stripRun = (r: EvidenceRowShape & { sync_run_id?: string }): EvidenceRowShape => {
  const { sync_run_id: _unused, ...row } = r;
  void _unused;
  return row;
};

describe('dry-run (the default)', () => {
  it('prints counts only, writes nothing, never opens the sink', async () => {
    const run = await makeLedger('d1');
    const sink = new RecordingSink();
    const makeSink = vi.fn(async () => sink);
    const io = loadIo(sink, { makeSink });
    const out = await runLoad(loadArgs(run.dir), io);

    expect(out.exitCode).toBe(LOAD_EXIT.dryRun);
    expect(makeSink).not.toHaveBeenCalled();
    expect(sink.started).toHaveLength(0);
    const text = io.printed.join('\n');
    expect(text).toContain('LEDGER LOAD (dry-run)');
    expect(text).toMatch(/ledger cells: copy 1, ok 3/);
    expect(text).toContain('copies (identical content, $0): expanded 1');
    expect(text).toMatch(/rows by person_kind: .*staff \d+/);
    expect(text).toMatch(/rows by withheld_reason: .*none \d+/);
    // No name, quote or file id of the (synthetic) documents in stdout.
    for (const secret of [
      'Falkenrath',
      'Marek',
      'Orlovsky',
      'Wieczorkiewicz',
      'Creative Director',
      'file-',
      'ACME12345678',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('counts rows by person_kind and withheld_reason, and the copy rows', async () => {
    const run = await makeLedger('d2');
    const out = await runLoad(loadArgs(run.dir), loadIo(new RecordingSink()));
    const { report } = out;
    // 4 mentions per document, 3 ok cells + 1 expanded copy = 4 documents.
    expect(report.okCells).toBe(3);
    expect(report.resolve.copies.expanded).toBe(1);
    expect(report.resolve.copies.rows).toBe(report.resolve.mentions / 4);
    expect(report.rows).toHaveLength(report.rowsBuilt - report.duplicatesAcrossCells);
    expect(report.byKind['staff']).toBeGreaterThan(0);
    expect(report.byKind['external_unresolved']).toBeGreaterThan(0);
    const kinds = Object.values(report.byKind).reduce((a, b) => a + b, 0);
    expect(kinds).toBe(report.rows.length);
    expect(report.byWithheldReason['none']).toBe(report.byKind['staff']);
    // The ledger's three documents carry identical text except the file id line, but the
    // model answer is canned: one claim hash per (file, claim), so no cross-cell duplicates.
    expect(report.duplicatesAcrossCells).toBe(0);
  });

  it('counts a claim that sits in two ok cells once (duplicates by claim_hash)', async () => {
    const run = await makeLedger('d3');
    const file = path.join(run.dir, 'cells.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const okLine = JSON.parse(lines.find((l) => JSON.parse(l).status === 'ok') as string);
    // The same file under another cell key (e.g. an edited version): same claims, new cell.
    fs.appendFileSync(file, JSON.stringify({ ...okLine, cellKey: 'another-cell-key' }) + '\n');
    const out = await runLoad(loadArgs(run.dir), loadIo(new RecordingSink()));
    expect(out.report.duplicatesAcrossCells).toBeGreaterThan(0);
    expect(out.report.rows).toHaveLength(out.report.rowsBuilt - out.report.duplicatesAcrossCells);
  });
});

describe('rows are what the stage produces', () => {
  it('equal to the rows the stage resolved for the same cells, copies included', async () => {
    const run = await makeLedger('r1');
    expect(run.stageRows.size).toBeGreaterThan(0);
    const out = await runLoad(loadArgs(run.dir), loadIo(new RecordingSink()));

    const stage = [...run.stageRows.values()].map(stripRun);
    const loaded = [...out.report.rows];
    const order = (a: EvidenceRowShape, b: EvidenceRowShape): number =>
      `${a.file_id}|${a.claim_hash}` < `${b.file_id}|${b.claim_hash}` ? -1 : 1;
    expect(loaded.sort(order)).toEqual(stage.sort(order));
    // The copy got rows under its own file, account and job number.
    const copyRows = loaded.filter((r) => r.file_id === 'file-copy');
    expect(copyRows.length).toBeGreaterThan(0);
    expect(new Set(copyRows.map((r) => r.job_number))).toEqual(new Set(['ACME12345678']));
  });

  it('stamps the ledger header version, not another', async () => {
    const run = await makeLedger('r2');
    const out = await runLoad(loadArgs(run.dir), loadIo(new RecordingSink()));
    const header = JSON.parse(fs.readFileSync(path.join(run.dir, PILOT_HEADER_FILE), 'utf8'));
    expect(header.extractorVersion).toBe(`t3-${T3_PROMPT_VERSION}:gemini-3.5-flash:low`);
    expect(new Set(out.report.rows.map((r) => r.extractor_version))).toEqual(
      new Set([header.extractorVersion]),
    );
  });

  it('a roster change moves rows from external to staff without a model call', async () => {
    const run = await makeLedger('r3');
    const empty = await runLoad(
      loadArgs(run.dir),
      loadIo(new RecordingSink(), { loadRoster: async () => buildRosterIndex([]) }),
    );
    expect(empty.report.byKind['staff'] ?? 0).toBe(0);
    const full = await runLoad(loadArgs(run.dir), loadIo(new RecordingSink()));
    expect(full.report.byKind['staff']).toBeGreaterThan(0);
  });
});

describe('run date of the period clamp', () => {
  /** Makes every mention of the first ok cell state the period "2026" (ends after the pilot's run date). */
  function withPeriod2026(dir: string): void {
    const file = path.join(dir, 'cells.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out = lines.map((l) => {
      const rec = JSON.parse(l);
      if (rec.status !== 'ok') return l;
      return JSON.stringify({
        ...rec,
        mentions: rec.mentions.map((m: object) => ({ ...m, periodText: '2026' })),
      });
    });
    fs.writeFileSync(file, out.join('\n') + '\n');
  }

  it('comes from header.createdAt: two loads on different "today" give the same period_end', async () => {
    const run = await makeLedger('t1');
    withPeriod2026(run.dir);
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
      const early = await runLoad(loadArgs(run.dir), loadIo(new RecordingSink()));
      vi.setSystemTime(new Date('2028-03-05T00:00:00Z'));
      const late = await runLoad(loadArgs(run.dir), loadIo(new RecordingSink()));
      expect(late.report.rows).toEqual(early.report.rows);
      const ends = new Set(early.report.rows.map((r) => r.period_end));
      // Clamped to the pilot's run day (2026-11-20), not to either load day and not 2026-12-31.
      expect(ends).toEqual(new Set(['2026-11-20']));
      expect(early.report.runDay).toBe('2026-11-20');
      expect(late.report.runDay).toBe('2026-11-20');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['missing', undefined],
    ['not a string', 20261120],
    ['not ISO', 'last Friday'],
    ['a date without a time', '2026-11-20'],
    ['an impossible date', '2026-13-45T00:00:00Z'],
  ])('refuses a header whose createdAt is %s (no fallback to today)', async (_name, value) => {
    const run = await makeLedger(`t2-${String(_name).replace(/\W/g, '')}`);
    const file = path.join(run.dir, PILOT_HEADER_FILE);
    const header = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === undefined) delete header.createdAt;
    else header.createdAt = value;
    fs.writeFileSync(file, JSON.stringify(header));
    const roster = vi.fn(async () => buildRosterIndex([]));
    await expect(
      runLoad(loadArgs(run.dir), loadIo(new RecordingSink(), { loadRoster: roster })),
    ).rejects.toThrow(/no usable createdAt/);
    expect(roster).not.toHaveBeenCalled();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await runLoadCli(
      ['--ledger-dir', run.dir, '--account-id', ACCT],
      loadIo(new RecordingSink()),
    );
    err.mockRestore();
    expect(code).toBe(2);
  });
});

describe('guards', () => {
  const refuse = async (run: Promise<unknown>, re: RegExp): Promise<void> => {
    await expect(run).rejects.toThrow(re);
  };

  it('refuses another account than the ledger header', async () => {
    const run = await makeLedger('g1');
    const sink = new RecordingSink();
    const roster = vi.fn(async () => buildRosterIndex([]));
    await refuse(
      runLoad(
        loadArgs(run.dir, { accountId: OTHER_ACCT, mode: 'apply' }),
        loadIo(sink, { loadRoster: roster }),
      ),
      /not the account this ledger was run for/,
    );
    expect(roster).not.toHaveBeenCalled();
    expect(sink.started).toHaveLength(0);
  });

  it('refuses a ledger inside the repository checkout', async () => {
    const inside = path.join(repo, 'ledger');
    fs.mkdirSync(inside);
    await refuse(
      runLoad(loadArgs(inside), loadIo(new RecordingSink())),
      /outside the repository checkout/,
    );
    await refuse(
      runLoad(loadArgs(repo), loadIo(new RecordingSink())),
      /outside the repository checkout/,
    );
  });

  it('refuses a missing directory, a missing header and missing cells, and creates nothing', async () => {
    const missing = path.join(ledgers, 'nope');
    await refuse(runLoad(loadArgs(missing), loadIo(new RecordingSink())), /does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
    const empty = path.join(ledgers, 'empty');
    fs.mkdirSync(empty);
    await refuse(runLoad(loadArgs(empty), loadIo(new RecordingSink())), /no header\.json/);
    expect(fs.readdirSync(empty)).toEqual([]);
    const run = await makeLedger('g2');
    fs.rmSync(path.join(run.dir, 'cells.jsonl'));
    await refuse(runLoad(loadArgs(run.dir), loadIo(new RecordingSink())), /no cells\.jsonl/);
  });

  it('refuses a header whose extractor version is not the one its signature gives', async () => {
    const run = await makeLedger('g3');
    const file = path.join(run.dir, PILOT_HEADER_FILE);
    const header = JSON.parse(fs.readFileSync(file, 'utf8'));
    header.extractorVersion = 't3-v1:some-other-model:low';
    fs.writeFileSync(file, JSON.stringify(header));
    await refuse(runLoad(loadArgs(run.dir), loadIo(new RecordingSink())), /inconsistent/);
  });

  it('refuses a ledger written under another prompt version than this code', async () => {
    const run = await makeLedger('g4');
    const file = path.join(run.dir, PILOT_HEADER_FILE);
    const header = JSON.parse(fs.readFileSync(file, 'utf8'));
    header.signature.promptVersion = 'v0';
    header.extractorVersion = 't3-v0:gemini-3.5-flash:low';
    fs.writeFileSync(file, JSON.stringify(header));
    await refuse(
      runLoad(loadArgs(run.dir), loadIo(new RecordingSink())),
      /written under prompt version v0, this code is v1/,
    );
  });

  it('refuses an ok cell that carries another extractor version than the header', async () => {
    const run = await makeLedger('g5');
    const file = path.join(run.dir, 'cells.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const okLine = JSON.parse(lines.find((l) => JSON.parse(l).status === 'ok') as string);
    fs.appendFileSync(
      file,
      JSON.stringify({ ...okLine, cellKey: 'x', extractorVersion: 't3-v1:other:low' }) + '\n',
    );
    await refuse(runLoad(loadArgs(run.dir), loadIo(new RecordingSink())), /mixes configurations/);
  });

  it('refuses a cell of another account than --account-id', async () => {
    const run = await makeLedger('g6');
    const file = path.join(run.dir, 'cells.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const okLine = JSON.parse(lines.find((l) => JSON.parse(l).status === 'ok') as string);
    okLine.cellKey = 'foreign';
    okLine.candidate.accountId = OTHER_ACCT;
    fs.appendFileSync(file, JSON.stringify(okLine) + '\n');
    await refuse(
      runLoad(loadArgs(run.dir), loadIo(new RecordingSink())),
      /belong to another account/,
    );
  });

  it('refuses a ledger with no ok cell', async () => {
    const run = await makeLedger('g7');
    fs.writeFileSync(path.join(run.dir, 'cells.jsonl'), '');
    await refuse(runLoad(loadArgs(run.dir), loadIo(new RecordingSink())), /no ok cell/);
  });

  it('reports a torn last line instead of hiding it', async () => {
    const run = await makeLedger('g8');
    fs.appendFileSync(path.join(run.dir, 'cells.jsonl'), '{"v":1,"cellKey":"torn"');
    const out = await runLoad(loadArgs(run.dir), loadIo(new RecordingSink()));
    expect(out.report.unreadableLines).toBe(1);
  });
});

describe('apply', () => {
  it('opens one sync run, inserts the rows in batches and is idempotent on a second run', async () => {
    const run = await makeLedger('a1');
    const sink = new RecordingSink();
    const first = await runLoad(loadArgs(run.dir, { mode: 'apply' }), loadIo(sink));
    expect(first.exitCode).toBe(LOAD_EXIT.ok);
    expect(sink.started).toHaveLength(1);
    expect(sink.started[0]?.extractorVersion).toBe(`t3-${T3_PROMPT_VERSION}:gemini-3.5-flash:low`);
    expect(sink.finished).toHaveLength(1);
    expect(sink.finished[0]?.status).toBe('success');
    const total = first.report.rows.length;
    expect(first.report.applied).toMatchObject({ inserted: total, alreadyPresent: 0 });
    expect(sink.inner.rows.size).toBe(total);
    // The details of the run record carry counts and ids only.
    const details = JSON.stringify([sink.started[0]?.details, sink.finished[0]?.details]);
    expect(details).not.toMatch(/Falkenrath|Marek|Orlovsky|file-/);

    const second = await runLoad(loadArgs(run.dir, { mode: 'apply' }), loadIo(sink));
    expect(second.report.applied).toMatchObject({ inserted: 0, alreadyPresent: total });
    expect(sink.inner.rows.size).toBe(total);
  });

  it('splits a large load into batches of LOAD_BATCH', async () => {
    const run = await makeLedger('a2');
    // Many mentions in one cell: enough rows for three batches.
    const file = path.join(run.dir, 'cells.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const okIdx = lines.findIndex((l) => JSON.parse(l).status === 'ok');
    const rec = JSON.parse(lines[okIdx] as string);
    const many = Array.from({ length: LOAD_BATCH * 2 + 7 }, (_, i) => ({
      ...rec.mentions[0],
      rawName: `Person qx${i} Example`,
    }));
    lines[okIdx] = JSON.stringify({ ...rec, mentions: many });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const sink = new RecordingSink();
    await runLoad(loadArgs(run.dir, { mode: 'apply' }), loadIo(sink));
    expect(sink.batches.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sink.batches)).toBe(LOAD_BATCH);
    expect(sink.batches.reduce((a, b) => a + b, 0)).toBe(sink.inner.rows.size);
  });

  it('a sink that refuses at startRun (no evidence table) leaves nothing and surfaces the message', async () => {
    const run = await makeLedger('a3');
    const finishRun = vi.fn();
    const writeEvidence = vi.fn();
    const sink: T3Sink = {
      startRun: async () => {
        throw new SinkUnavailableError('the evidence table does not exist (42P01)');
      },
      writeEvidence,
      finishRun,
    };
    await expect(runLoad(loadArgs(run.dir, { mode: 'apply' }), loadIo(sink))).rejects.toThrow(
      /42P01/,
    );
    expect(writeEvidence).not.toHaveBeenCalled();
    expect(finishRun).not.toHaveBeenCalled();
  });

  it('a write failure after the run opened ends the run failed and rethrows', async () => {
    const run = await makeLedger('a4');
    const inner = new RecordingSink();
    const sink: T3Sink = {
      startRun: (i) => inner.startRun(i),
      writeEvidence: async () => {
        throw new Error('insert failed: constraint');
      },
      finishRun: (id, o) => inner.finishRun(id, o),
    };
    await expect(runLoad(loadArgs(run.dir, { mode: 'apply' }), loadIo(sink))).rejects.toThrow(
      /insert failed/,
    );
    expect(inner.finished).toHaveLength(1);
    expect(inner.finished[0]?.status).toBe('failed');
    expect(JSON.stringify(inner.finished[0]?.details)).toContain('insert failed');
  });
});

describe('command line', () => {
  const argv = (dir: string, ...extra: string[]): string[] => [
    '--ledger-dir',
    dir,
    '--account-id',
    ACCT,
    ...extra,
  ];

  it('parses repeatable flags and is dry-run by default', () => {
    const a = parseLoadArgs(
      argv(
        '/abs/ledger',
        '--agency-domain',
        'Agency.Example',
        '--agency-domain',
        'other.example',
        '--unknown-start-date',
        '2026-04-22',
      ),
    );
    expect(a.mode).toBe('dry-run');
    expect(a.agencyDomains).toEqual(['agency.example', 'other.example']);
    expect(a.unknownStartDates).toEqual(['2026-04-22']);
    expect(parseLoadArgs(argv('/abs/ledger', '--apply')).mode).toBe('apply');
  });

  it.each([
    [['--account-id', ACCT], /absolute/],
    [['--ledger-dir', 'relative/dir', '--account-id', ACCT], /absolute/],
    [['--ledger-dir', '/abs', '--account-id', 'not-a-uuid'], /UUID/],
    [argv('/abs', '--aply'), /unknown flag --aply/],
    [argv('/abs', 'stray'), /unexpected argument stray/],
    [argv('/abs', '--apply', 'yes'), /unexpected argument yes/],
    [argv('/abs', '--agency-domain'), /needs a value/],
    [argv('/abs', '--agency-domain', 'a@b.example'), /bare domain/],
    [argv('/abs', '--unknown-start-date', '2026-13-45'), /YYYY-MM-DD/],
    [argv('/abs', '--ledger-dir', '/other'), /given twice/],
  ] as const)('refuses %j', (input, re) => {
    expect(() => parseLoadArgs(input)).toThrow(re);
  });

  it('the CLI maps a refusal to exit 2, a dry-run to 3, an apply to 0', async () => {
    const run = await makeLedger('c1');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sink = new RecordingSink();
    expect(await runLoadCli(argv(run.dir, '--aply'), loadIo(sink))).toBe(2);
    expect(
      await runLoadCli(['--ledger-dir', run.dir, '--account-id', OTHER_ACCT], loadIo(sink)),
    ).toBe(2);
    expect(await runLoadCli(argv(run.dir), loadIo(sink))).toBe(3);
    expect(sink.started).toHaveLength(0);
    expect(await runLoadCli(argv(run.dir, '--apply'), loadIo(sink))).toBe(0);
    expect(sink.started).toHaveLength(1);
    const refusing: T3Sink = {
      startRun: async () => {
        throw new SinkUnavailableError('migration missing');
      },
      writeEvidence: async () => ({ inserted: 0, duplicates: 0 }),
      finishRun: async () => undefined,
    };
    expect(await runLoadCli(argv(run.dir, '--apply'), loadIo(refusing))).toBe(2);
    const broken: T3Sink = {
      ...refusing,
      startRun: async () => {
        throw new Error('connection reset');
      },
    };
    expect(await runLoadCli(argv(run.dir, '--apply'), loadIo(broken))).toBe(1);
    err.mockRestore();
  });

  it('passes the roster options through', async () => {
    const run = await makeLedger('c2');
    const loadRoster = vi.fn(async () => roster());
    await runLoadCli(
      argv(run.dir, '--agency-domain', 'agency.example', '--unknown-start-date', '2026-04-22'),
      loadIo(new RecordingSink(), { loadRoster }),
    );
    expect(loadRoster).toHaveBeenCalledWith({
      unknownStartDates: ['2026-04-22'],
      agencyDomains: ['agency.example'],
    });
  });
});
