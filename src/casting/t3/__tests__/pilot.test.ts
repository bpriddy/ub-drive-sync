/**
 * The pilot driver, end to end on synthetic data: fake listing, fake reader, fake model.
 * No test here reaches Drive, a database or a real model client.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRosterIndex } from '../../identity';
import { JsonlLedger } from '../ledger';
import {
  GuardError,
  PILOT_EXIT,
  type BeforeApplyInfo,
  PILOT_HEADER_FILE,
  inspectLedgerDir,
  runPilot,
  signatureOf,
  type PilotIo,
} from '../pilot';
import { parsePilotArgs, type PilotArgs } from '../pilot-args';
import { MemorySink } from '../sink';
import type { T3Candidate } from '../types';
import { runPilotCli } from '../pilot-main';
import { CREDITS_DECK, FakeLlm, GDOC, GSLIDES, PDF, answer, cand } from './helpers';

const ACCT = '11111111-1111-4111-8111-111111111111';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const NOW = new Date('2026-11-20T00:00:00Z');

/** Three-letter suffixes keep names, folders and version families all distinct. */
const word = (i: number): string =>
  `q${String.fromCharCode(97 + (Math.floor(i / 676) % 26), 97 + (Math.floor(i / 26) % 26), 97 + (i % 26))}`;

const CLASSES = [GSLIDES, GSLIDES, PDF, GDOC, PPTX];

function synth(n: number): T3Candidate[] {
  return Array.from({ length: n }, (_, i) => {
    const mimeType = CLASSES[i % CLASSES.length] as string;
    return cand({
      fileId: `file-${String(i).padStart(4, '0')}`,
      name: mimeType === GDOC ? `Brief ${word(i)}` : `Review ${word(i)}`,
      mimeType,
      ancestors: ['root', `Folder ${word(i)}`],
      accountId: ACCT,
    });
  });
}

let tmp: string;
let repo: string;
let ledgers: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-test-'));
  repo = path.join(tmp, 'repo');
  ledgers = path.join(tmp, 'ledgers');
  fs.mkdirSync(repo);
  fs.mkdirSync(ledgers);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Harness {
  io: PilotIo;
  printed: string[];
  llm: FakeLlm;
  sinks: MemorySink[];
  spies: {
    makeReader: ReturnType<typeof vi.fn>;
    makeLlm: ReturnType<typeof vi.fn>;
    makeSink: ReturnType<typeof vi.fn>;
  };
  reads: string[];
}

function harness(candidates: readonly T3Candidate[]): Harness {
  const printed: string[] = [];
  const reads: string[] = [];
  const llm = new FakeLlm(() =>
    answer('credits_or_team', [
      {
        raw_name: 'Jürgen Falkenrath',
        raw_role: 'Creative Director',
        quote: 'Creative Director: Jürgen Falkenrath',
      },
    ]),
  );
  const sinks: MemorySink[] = [];
  const makeReader = vi.fn(() => ({
    async read(c: T3Candidate) {
      reads.push(c.fileId);
      return { kind: 'ok' as const, text: `${CREDITS_DECK}\n\nDocument ${c.fileId}` };
    },
  }));
  const makeLlm = vi.fn(async () => llm);
  const makeSink = vi.fn(() => {
    const s = new MemorySink();
    sinks.push(s);
    return s;
  });
  const io: PilotIo = {
    loadCandidates: async () => candidates,
    loadRoster: async () => buildRosterIndex([]),
    makeReader,
    makeLlm,
    makeSink,
    openLedger: (dir) => new JsonlLedger(dir, repo),
    repoRoots: [repo],
    print: (l) => printed.push(l),
    now: NOW,
  };
  return { io, printed, llm, sinks, spies: { makeReader, makeLlm, makeSink }, reads };
}

const BASE = [
  '--account-id',
  ACCT,
  '--window-start',
  '2021-11-19',
  '--sample-seed',
  'seed-a',
  '--model',
  'gemini-3.5-flash',
  '--thinking',
  'LOW',
  '--parallel',
  '2',
];
const args = (...extra: string[]): PilotArgs => parsePilotArgs([...BASE, ...extra]);
const applyArgs = (dir: string, size = 20, extra: string[] = []): PilotArgs =>
  args(
    '--sample-size',
    String(size),
    '--apply',
    '--max-cells',
    String(size),
    '--max-usd',
    '5',
    '--ledger-dir',
    dir,
    ...extra,
  );

describe('argument guards (parsePilotArgs)', () => {
  it('defaults: dry-run, sample size 120, LOW, base variant', () => {
    const a = parsePilotArgs([
      '--account-id',
      ACCT,
      '--window-start',
      '2021-11-19',
      '--sample-seed',
      's',
    ]);
    expect(a).toMatchObject({
      mode: 'dry-run',
      sampleSize: 120,
      variant: 'base',
      thinkingLevel: 'LOW',
      parallel: 1,
    });
  });

  it('a seed, an account id and a window start are required', () => {
    expect(() => parsePilotArgs(['--account-id', ACCT, '--window-start', '2021-11-19'])).toThrow(
      /sample-seed/,
    );
    expect(() => parsePilotArgs(['--sample-seed', 's', '--window-start', '2021-11-19'])).toThrow(
      /account-id/,
    );
    expect(() =>
      parsePilotArgs([
        '--account-id',
        'nope',
        '--sample-seed',
        's',
        '--window-start',
        '2021-11-19',
      ]),
    ).toThrow(/account-id/);
    expect(() => parsePilotArgs(['--account-id', ACCT, '--sample-seed', 's'])).toThrow(
      /window-start/,
    );
  });

  it('apply needs both limits and a ledger dir; they stay as strict as the stage', () => {
    expect(() => args('--apply')).toThrow(/max-cells/);
    expect(() => args('--apply', '--max-cells', '120')).toThrow(/max-cells.*max-usd/);
    expect(() => args('--apply', '--max-cells', '120', '--max-usd', '6')).toThrow(/ledger-dir/);
    expect(() => args('--max-cells', '120', '--max-usd', '6')).toThrow(
      /only mean something with --apply/,
    );
  });

  it('the ledger dir must be absolute', () => {
    expect(() =>
      args('--apply', '--max-cells', '120', '--max-usd', '6', '--ledger-dir', 'rel/dir'),
    ).toThrow(/absolute/);
  });

  it('--max-cells below the sample size is refused', () => {
    expect(() =>
      args(
        '--apply',
        '--sample-size',
        '120',
        '--max-cells',
        '100',
        '--max-usd',
        '6',
        '--ledger-dir',
        '/abs/x',
      ),
    ).toThrow(/below the sample size/);
    expect(
      args(
        '--apply',
        '--sample-size',
        '120',
        '--max-cells',
        '120',
        '--max-usd',
        '6',
        '--ledger-dir',
        '/abs/x',
      ).approval,
    ).toEqual({ maxCells: 120, maxCostUsd: 6 });
  });

  it('parallel is 1 or 2, unknown flags are errors', () => {
    expect(() => args('--parallel', '3')).toThrow(/parallel/);
    expect(() => args('--max-cell', '5')).toThrow(/unknown flag/);
    expect(() => args('--sample-size', '0')).toThrow(/sample-size/);
  });

  it('--unknown-start-date: absent = [], accepted, repeatable, deduplicated', () => {
    expect(args().unknownStartDates).toEqual([]);
    expect(args('--unknown-start-date', '2000-01-01').unknownStartDates).toEqual(['2000-01-01']);
    expect(
      args(
        '--unknown-start-date',
        '2000-01-01',
        '--unknown-start-date',
        '2001-02-03',
        '--unknown-start-date',
        '2000-01-01',
      ).unknownStartDates,
    ).toEqual(['2000-01-01', '2001-02-03']);
  });

  it('--unknown-start-date: a bad or missing value is refused', () => {
    expect(() => args('--unknown-start-date', '2000-1-1')).toThrow(/YYYY-MM-DD/);
    expect(() => args('--unknown-start-date', '2000-13-45')).toThrow(/YYYY-MM-DD/);
    expect(() => args('--unknown-start-date', 'later')).toThrow(/YYYY-MM-DD/);
    expect(() => args('--unknown-start-date')).toThrow(/needs a value/);
    expect(() => args('--unknown-start-date', '--parallel', '2')).toThrow(/needs a value/);
  });

  it('--unknown-start-date is a roster option: it is not part of the ledger signature', () => {
    expect(signatureOf(args('--unknown-start-date', '2000-01-01'))).toEqual(signatureOf(args()));
  });
});

describe('dry-run (the default)', () => {
  it('prints the PROPOSAL block first, exits 3, creates no client, sink, reader or directory', async () => {
    const h = harness(synth(60));
    const dir = path.join(ledgers, 'p1');
    const out = await runPilot(args('--sample-size', '20', '--ledger-dir', dir), h.io);
    expect(out.exitCode).toBe(PILOT_EXIT.dryRun);
    expect(h.printed[0]).toMatch(/^PROPOSAL \(no run started\)\ncells \(files\): 20 /);
    expect(h.printed.join('\n')).toContain(`ledger dir: ${dir}   state: absent`);
    expect(h.spies.makeLlm).not.toHaveBeenCalled();
    expect(h.spies.makeSink).not.toHaveBeenCalled();
    expect(h.spies.makeReader).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
    expect(h.llm.calls).toHaveLength(0);
  });

  it('hands --unknown-start-date to the roster loader; none = an empty list', async () => {
    const h = harness(synth(60));
    const loadRoster = vi.fn(async () => buildRosterIndex([]));
    const io: PilotIo = { ...h.io, loadRoster };
    await runPilot(args('--sample-size', '20'), io);
    await runPilot(
      args(
        '--sample-size',
        '20',
        '--unknown-start-date',
        '2000-01-01',
        '--unknown-start-date',
        '2001-02-03',
      ),
      io,
    );
    expect(loadRoster.mock.calls).toEqual([
      [{ unknownStartDates: [] }],
      [{ unknownStartDates: ['2000-01-01', '2001-02-03'] }],
    ]);
  });

  it('prints the sample, its seed and the per-class counts', async () => {
    const h = harness(synth(60));
    await runPilot(args('--sample-size', '20'), h.io);
    const text = h.printed.join('\n');
    expect(text).toContain('seed: seed-a');
    expect(text).toMatch(/sample: 20 of 60 \(requested 20\)/);
    expect(text).toMatch(/sample by class \(sample\/pool\): .*gslides \d+\/24/);
  });

  it('draws the sample from kept cells only: copies are never cells and never read', async () => {
    const list = synth(10).map((c, i) => (i === 0 ? { ...c, md5Checksum: 'md5-x' } : c));
    const copy = cand({
      fileId: 'file-copy',
      name: `Review ${word(900)}`,
      mimeType: GSLIDES,
      ancestors: ['root', 'Other [ACME12345678]'],
      accountId: ACCT,
      md5Checksum: 'md5-x',
      projectRef: { jobNumber: 'ACME12345678' },
    });
    const h = harness([...list, copy]);
    const out = await runPilot(args('--sample-size', '100', '--read-text'), h.io);
    expect(out.sample.fileIds).not.toContain('file-copy');
    expect(out.sample.fileIds).toHaveLength(10);
    expect(h.reads).toHaveLength(10);
    expect(h.reads).not.toContain('file-copy');
    expect(h.printed[0]).toContain('copies expanded, no model call, $0: 1');
  });

  it('with --read-text it reads exactly the sampled cells (zero model calls) and sizes them', async () => {
    const h = harness(synth(60));
    const out = await runPilot(args('--sample-size', '20', '--read-text'), h.io);
    expect(h.reads.sort()).toEqual([...out.sample.fileIds]);
    expect(h.llm.calls).toHaveLength(0);
    expect(h.spies.makeLlm).not.toHaveBeenCalled();
    expect(h.printed.join('\n')).toMatch(/documents read, 20 sized, 0 unsized/);
    expect(h.printed.join('\n')).toMatch(/measured text length \(chars\): n=20 /);
  });

  it('is repeatable: same listing and seed print the same proposal', async () => {
    const a = harness(synth(60));
    const b = harness(synth(60));
    await runPilot(args('--sample-size', '20', '--read-text'), a.io);
    await runPilot(args('--sample-size', '20', '--read-text'), b.io);
    expect(b.printed).toEqual(a.printed);
  });

  it('a ledger directory inside the repository is refused, also in a dry-run', async () => {
    const h = harness(synth(10));
    const inside = path.join(repo, 'ledger');
    await expect(
      runPilot(args('--sample-size', '5', '--ledger-dir', inside), h.io),
    ).rejects.toThrow(GuardError);
    expect(fs.existsSync(inside)).toBe(false);
    expect(h.printed).toEqual([]);
  });
});

describe('apply guards', () => {
  it('a ledger directory inside the repository is refused before any client exists', async () => {
    const h = harness(synth(10));
    await expect(runPilot(applyArgs(path.join(repo, 'ledger'), 5), h.io)).rejects.toThrow(
      /outside the repository/,
    );
    expect(h.spies.makeLlm).not.toHaveBeenCalled();
  });

  it('a selection above --max-cells is refused, nothing is started', async () => {
    const h = harness(synth(30));
    const dir = path.join(ledgers, 'p1');
    // Built by hand: parsePilotArgs already refuses --max-cells below the sample size.
    const bad: PilotArgs = { ...applyArgs(dir, 20), approval: { maxCells: 10, maxCostUsd: 5 } };
    await expect(runPilot(bad, h.io)).rejects.toThrow(/above --max-cells 10/);
    expect(h.spies.makeLlm).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
    expect(h.printed).toEqual([]);
  });

  it('a non-empty directory without a pilot header is refused', async () => {
    const dir = path.join(ledgers, 'p1');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'cells.jsonl'), '{}\n');
    const h = harness(synth(30));
    await expect(runPilot(applyArgs(dir), h.io)).rejects.toThrow(/no pilot header/);
    expect(h.spies.makeLlm).not.toHaveBeenCalled();
  });

  it('an empty existing directory is accepted', async () => {
    const dir = path.join(ledgers, 'p1');
    fs.mkdirSync(dir);
    const h = harness(synth(30));
    const out = await runPilot(applyArgs(dir), h.io);
    expect(out.exitCode).toBe(PILOT_EXIT.ok);
  });
});

describe('apply (mocked model only)', () => {
  it('prints the PROPOSAL first, writes header and ledger, sends only the sampled cells, writes no DB', async () => {
    const list = synth(60).map((c, i) => (i === 0 ? { ...c, md5Checksum: 'md5-x' } : c));
    const copy = cand({
      fileId: 'file-copy',
      name: `Review ${word(900)}`,
      mimeType: GSLIDES,
      ancestors: ['root', 'Other [ACME12345678]'],
      accountId: ACCT,
      md5Checksum: 'md5-x',
      projectRef: { jobNumber: 'ACME12345678' },
    });
    const h = harness([...list, copy]);
    const dir = path.join(ledgers, 'p1');
    const out = await runPilot(applyArgs(dir, 20), h.io);

    expect(out.exitCode).toBe(PILOT_EXIT.ok);
    expect(h.printed[0]).toMatch(/^PROPOSAL \(no run started\)/);
    expect(h.spies.makeLlm).toHaveBeenCalledTimes(1);
    expect(h.llm.calls).toHaveLength(20);
    expect(h.reads).not.toContain('file-copy');

    const header = JSON.parse(fs.readFileSync(path.join(dir, PILOT_HEADER_FILE), 'utf8'));
    expect(header.sample.seed).toBe('seed-a');
    expect(header.sample.fileIds).toEqual([...out.sample.fileIds]);
    expect(header.sample.sampleByClass).toEqual(out.sample.sampleByClass);
    expect(header.signature).toEqual(signatureOf(applyArgs(dir, 20)));

    const cells = fs
      .readFileSync(path.join(dir, 'cells.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(cells.filter((c) => c.status === 'ok')).toHaveLength(20);

    // The only sink is the in-memory one: nothing outside the process was written.
    expect(h.sinks).toHaveLength(1);
    expect(h.sinks[0]?.runs[0]?.status).toBe('success');
  });

  it('resumes from the ledger: the same seed does not call the model again', async () => {
    const h = harness(synth(60));
    const dir = path.join(ledgers, 'p1');
    await runPilot(applyArgs(dir, 20), h.io);
    expect(h.llm.calls).toHaveLength(20);
    const again = await runPilot(applyArgs(dir, 20), h.io);
    expect(again.exitCode).toBe(PILOT_EXIT.ok);
    expect(h.llm.calls).toHaveLength(20);
    expect(h.printed.join('\n')).toMatch(/already done in the ledger: 20 {3}to run: 0/);
    expect(h.printed.join('\n')).toContain('[resumed: cells taken from the ledger header]');
  });

  it('resumes an existing ledger when only --unknown-start-date differs', async () => {
    const h = harness(synth(60));
    const dir = path.join(ledgers, 'p1');
    await runPilot(applyArgs(dir, 20), h.io);
    const callsBefore = h.llm.calls.length;
    const out = await runPilot(applyArgs(dir, 20, ['--unknown-start-date', '2000-01-01']), h.io);
    expect(out.exitCode).toBe(PILOT_EXIT.ok);
    expect(h.llm.calls).toHaveLength(callsBefore);
  });

  it('another seed or configuration on the same directory is refused', async () => {
    const h = harness(synth(60));
    const dir = path.join(ledgers, 'p1');
    await runPilot(applyArgs(dir, 20), h.io);
    const otherSeed = parsePilotArgs([
      '--account-id',
      ACCT,
      '--window-start',
      '2021-11-19',
      '--sample-seed',
      'seed-b',
      '--sample-size',
      '20',
      '--apply',
      '--max-cells',
      '20',
      '--max-usd',
      '5',
      '--ledger-dir',
      dir,
    ]);
    await expect(runPilot(otherSeed, h.io)).rejects.toThrow(
      /another seed or configuration \(differs: seed\)/,
    );
    const otherArm = applyArgs(dir, 20, ['--thinking', 'MINIMAL']);
    await expect(runPilot(otherArm, h.io)).rejects.toThrow(/differs: thinkingLevel/);
    expect(h.llm.calls).toHaveLength(20);
  });

  it('a resume whose sampled cells left the listing is refused', async () => {
    const list = synth(60);
    const h1 = harness(list);
    const dir = path.join(ledgers, 'p1');
    const first = await runPilot(applyArgs(dir, 20), h1.io);
    const gone = first.sample.fileIds[0] as string;
    const h2 = harness(list.filter((c) => c.fileId !== gone));
    await expect(runPilot(applyArgs(dir, 20), h2.io)).rejects.toThrow(/no longer in the shortlist/);
    expect(h2.llm.calls).toHaveLength(0);
  });

  it('stops at the cost ceiling with exit 4', async () => {
    const h = harness(synth(60));
    const dir = path.join(ledgers, 'p1');
    const a = applyArgs(dir, 20);
    const out = await runPilot({ ...a, approval: { maxCells: 20, maxCostUsd: 0.004 } }, h.io);
    expect(out.exitCode).toBe(PILOT_EXIT.stopped);
    expect(h.llm.calls.length).toBeLessThan(20);
  });

  it('a pool smaller than the sample size runs the whole pool', async () => {
    const h = harness(synth(7));
    const out = await runPilot(applyArgs(path.join(ledgers, 'p1'), 20), h.io);
    expect(out.sample.fileIds).toHaveLength(7);
    expect(h.llm.calls).toHaveLength(7);
  });
});

describe('inspectLedgerDir', () => {
  it('absent, empty, resumable', async () => {
    const sig = signatureOf(args('--sample-size', '20'));
    const dir = path.join(ledgers, 'x');
    expect(inspectLedgerDir(dir, sig).state).toBe('absent');
    fs.mkdirSync(dir);
    expect(inspectLedgerDir(dir, sig).state).toBe('empty');
    fs.writeFileSync(
      path.join(dir, PILOT_HEADER_FILE),
      JSON.stringify({ v: 1, signature: sig, sample: { fileIds: [] } }),
    );
    expect(inspectLedgerDir(dir, sig).state).toBe('resumable');
  });

  it('a path that is a file is refused', () => {
    const f = path.join(ledgers, 'file');
    fs.writeFileSync(f, 'x');
    expect(() => inspectLedgerDir(f, {})).toThrow(/not a directory/);
  });
});

describe('runPilotCli', () => {
  it('maps refusals to exit 2 and a dry-run to exit 3', async () => {
    const h = harness(synth(10));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runPilotCli(['--account-id', ACCT], h.io)).toBe(PILOT_EXIT.refused);
    expect(await runPilotCli([...BASE, '--sample-size', '5', '--apply'], h.io)).toBe(
      PILOT_EXIT.refused,
    );
    expect(await runPilotCli([...BASE, '--sample-size', '5'], h.io)).toBe(PILOT_EXIT.dryRun);
    err.mockRestore();
    expect(h.spies.makeLlm).not.toHaveBeenCalled();
  });
});

describe('beforeApply hook (the casting-run guard)', () => {
  it('runs after the PROPOSAL and before the header, the model client and the sink', async () => {
    const h = harness(synth(60));
    const dir = path.join(ledgers, 'hook');
    const seen: BeforeApplyInfo[] = [];
    const io: PilotIo = {
      ...h.io,
      beforeApply: (info) => {
        seen.push(info);
        expect(h.printed[0]).toMatch(/^PROPOSAL/);
        expect(fs.existsSync(path.join(dir, PILOT_HEADER_FILE))).toBe(false);
        expect(h.spies.makeLlm).not.toHaveBeenCalled();
        expect(h.spies.makeSink).not.toHaveBeenCalled();
      },
    };
    const out = await runPilot(applyArgs(dir, 20), io);
    expect(out.exitCode).toBe(PILOT_EXIT.ok);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ cells: 20, model: 'gemini-3.5-flash', baseComplete: true });
    expect(seen[0]?.baseCostUsd).toBeGreaterThan(0);
  });

  it('a GuardError from it refuses: no header, no client, no sink, no model call', async () => {
    const h = harness(synth(60));
    const dir = path.join(ledgers, 'hook-refused');
    const io: PilotIo = {
      ...h.io,
      beforeApply: () => {
        throw new GuardError('refused by the caller');
      },
    };
    await expect(runPilot(applyArgs(dir, 20), io)).rejects.toThrow(/refused by the caller/);
    expect(fs.existsSync(dir)).toBe(false);
    expect(h.spies.makeLlm).not.toHaveBeenCalled();
    expect(h.spies.makeSink).not.toHaveBeenCalled();
    expect(h.llm.calls).toHaveLength(0);
  });

  it('is not called in a dry-run', async () => {
    const h = harness(synth(60));
    const beforeApply = vi.fn();
    const out = await runPilot(args('--sample-size', '20'), { ...h.io, beforeApply });
    expect(out.exitCode).toBe(PILOT_EXIT.dryRun);
    expect(beforeApply).not.toHaveBeenCalled();
  });
});
