/**
 * The incremental pilot (S9 tasks 1 and 6) end to end on synthetic data: fake listing, fake
 * reader, fake model, in-memory sink, temp ledger directories. No Drive, database or model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import { findPaidTwice } from '../../run-all/guards';
import { JsonlLedger, cellKeyOf, extractorVersionOf, type CellRecord } from '../../t3/ledger';
import { LOAD_EXIT, runLoad } from '../../t3/load';
import {
  PILOT_CAP_CHARS,
  PILOT_EXIT,
  runPilot,
  type BeforeApplyInfo,
  type PilotIo,
} from '../../t3/pilot';
import { parsePilotArgs } from '../../t3/pilot-args';
import { MemorySink } from '../../t3/sink';
import { T3_PROMPT_VERSION, type T3Candidate } from '../../t3/types';
import { CREDITS_DECK, FakeLlm, GSLIDES, answer, cand } from '../../t3/__tests__/helpers';

const ACCT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-20T00:00:00Z');

let tmp: string;
let repo: string;
let ledgers: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-test-'));
  repo = path.join(tmp, 'repo');
  ledgers = path.join(tmp, 'ledgers');
  fs.mkdirSync(repo);
  fs.mkdirSync(ledgers);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const roster = () => buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] });
const LETTERS = 'abcdefghij';

/** Five distinct decks; `md5` and `modifiedTime` per file can be overridden to simulate edits. */
function listing(over: Record<string, Partial<T3Candidate>> = {}, extra: T3Candidate[] = []) {
  const base = Array.from({ length: 5 }, (_, i) =>
    cand({
      fileId: `file-${i}`,
      name: `Review q${LETTERS[i]}`,
      mimeType: GSLIDES,
      ancestors: ['root', `Folder q${LETTERS[i]}`],
      accountId: ACCT,
      md5Checksum: `md5-${i}`,
      projectRef: { jobNumber: `ACME0000000${i}` },
      ...(over[`file-${i}`] ?? {}),
    }),
  );
  return [...base, ...extra];
}

const modelAnswer = () =>
  answer('credits_or_team', [
    {
      raw_name: 'Jürgen Falkenrath',
      raw_role: 'Creative Director',
      quote: 'Creative Director: Jürgen Falkenrath',
    },
  ]);

interface Rig {
  io: PilotIo;
  printed: string[];
  llm: FakeLlm;
  makeLlm: ReturnType<typeof vi.fn>;
  makeSink: ReturnType<typeof vi.fn>;
  proposals: BeforeApplyInfo[];
}

function rig(list: readonly T3Candidate[]): Rig {
  const printed: string[] = [];
  const proposals: BeforeApplyInfo[] = [];
  const llm = new FakeLlm(() => modelAnswer());
  const makeLlm = vi.fn(async () => llm);
  const makeSink = vi.fn(() => new MemorySink());
  const io: PilotIo = {
    loadCandidates: async () => list,
    loadRoster: async () => roster(),
    makeReader: () => ({
      async read(c: T3Candidate) {
        return {
          kind: 'ok' as const,
          text: `${CREDITS_DECK}\n\nDocument ${c.fileId} ${c.md5Checksum}`,
        };
      },
    }),
    makeLlm,
    makeSink,
    openLedger: (d) => new JsonlLedger(d, repo),
    repoRoots: [repo],
    print: (l) => printed.push(l),
    onProposal: (i) => proposals.push(i),
    now: NOW,
  };
  return { io, printed, llm, makeLlm, makeSink, proposals };
}

const dirOf = (n: string): string => path.join(ledgers, n);
const BASE = ['--account-id', ACCT, '--window-start', '2021-11-19', '--sample-seed', 'incremental'];
const plan = (dir: string, extra: string[] = []) =>
  parsePilotArgs([
    ...BASE,
    '--incremental',
    '--sample-size',
    '1000',
    '--ledger-dir',
    dir,
    ...extra,
  ]);
const apply = (dir: string, extra: string[] = []) =>
  parsePilotArgs([
    ...BASE,
    '--incremental',
    '--sample-size',
    '10',
    '--apply',
    '--max-cells',
    '10',
    '--max-usd',
    '5',
    '--ledger-dir',
    dir,
    ...extra,
  ]);
const cellsOf = (dir: string): CellRecord[] => new JsonlLedger(dir, repo).load() as CellRecord[];

describe('argument rules', () => {
  it('--incremental needs an absolute --ledger-dir and takes no value', () => {
    expect(() => parsePilotArgs([...BASE, '--incremental'])).toThrow(/ledger-dir/);
    expect(() => parsePilotArgs([...BASE, '--incremental', '--ledger-dir', 'rel/x'])).toThrow(
      /absolute/,
    );
    expect(() =>
      parsePilotArgs([...BASE, '--incremental', 'yes', '--ledger-dir', '/abs/x']),
    ).toThrow(/takes no value/);
    expect(plan('/abs/x').incremental).toBe(true);
    expect(parsePilotArgs([...BASE]).incremental).toBe(false);
  });
});

describe('the first run, then quiet days', () => {
  it('pays every cell once, then a no-change day selects 0 cells, writes nothing, calls no model', async () => {
    const first = rig(listing());
    const out1 = await runPilot(apply(dirOf('d1')), first.io);
    expect(out1.exitCode).toBe(PILOT_EXIT.ok);
    expect(first.llm.calls).toHaveLength(5);
    expect(cellsOf(dirOf('d1')).filter((r) => r.status === 'ok')).toHaveLength(5);

    // Day 2, nothing changed.
    const quiet = rig(listing());
    const dry = await runPilot(plan(dirOf('d2')), quiet.io);
    expect(dry.exitCode).toBe(PILOT_EXIT.dryRun);
    expect(dry.sample.fileIds).toHaveLength(0);
    expect(quiet.proposals[0]?.cells).toBe(0);
    expect(quiet.proposals[0]?.baseCostUsd).toBe(0);

    const out2 = await runPilot(apply(dirOf('d2')), quiet.io);
    expect(out2.exitCode).toBe(PILOT_EXIT.ok);
    expect(out2.incremental).toMatchObject({ unchanged: 5, carries: [], toPay: [] });
    expect(quiet.makeLlm).not.toHaveBeenCalled();
    expect(quiet.makeSink).not.toHaveBeenCalled();
    expect(quiet.llm.calls).toHaveLength(0);
    // Nothing was created: no directory, no header, no cells.
    expect(fs.existsSync(dirOf('d2'))).toBe(false);
    expect(quiet.printed.join('\n')).toContain('no ledger written, no model call, $0');
  });

  it('a window slide changes no cell key: moving the cutoff forward re-pays nothing', async () => {
    await runPilot(apply(dirOf('d1')), rig(listing()).io);
    const slid = rig(listing());
    const out = await runPilot(
      parsePilotArgs([
        '--account-id',
        ACCT,
        '--window-start',
        '2024-01-01',
        '--sample-seed',
        'incremental',
        '--incremental',
        '--sample-size',
        '1000',
        '--ledger-dir',
        dirOf('d2'),
      ]),
      slid.io,
    );
    expect(out.incremental?.toPay).toHaveLength(0);
    expect(out.incremental?.unchanged).toBe(5);
  });
});

describe('changed and new files', () => {
  it('pays only the changed file; a new file with paid content is a $0 copy and loads as rows', async () => {
    await runPilot(apply(dirOf('d1')), rig(listing()).io);

    const copy = cand({
      fileId: 'file-copy',
      name: 'Review qz',
      mimeType: GSLIDES,
      ancestors: ['root', 'Other [ACME99999999]'],
      accountId: ACCT,
      md5Checksum: 'md5-2', // the content of the paid file-2
      projectRef: { jobNumber: 'ACME99999999' },
    });
    const day3 = rig(listing({ 'file-1': { md5Checksum: 'md5-1-edited' } }, [copy]));
    const out = await runPilot(apply(dirOf('d3')), day3.io);

    expect(out.exitCode).toBe(PILOT_EXIT.ok);
    expect(day3.llm.calls).toHaveLength(1);
    expect(out.incremental).toMatchObject({ unchanged: 4, paidContent: 0 });
    expect(out.incremental?.toPay.map((s) => s.candidate.fileId)).toEqual(['file-1']);
    expect(out.incremental?.carries.map((c) => [c.ref.fileId, c.why])).toEqual([
      ['file-copy', 'listing_copy'],
    ]);

    const recs = cellsOf(dirOf('d3'));
    expect(
      recs
        .filter((r) => r.status === 'ok')
        .map((r) => r.candidate.fileId)
        .sort(),
    ).toEqual([
      'file-1',
      'file-2', // the carried kept cell: no usage, no cost
    ]);
    const carried = recs.find((r) => r.candidate.fileId === 'file-2');
    expect(carried).toMatchObject({ usage: null, reason: 'carried_from_prior_ledger' });
    expect(recs.find((r) => r.status === 'copy')).toMatchObject({
      candidate: { fileId: 'file-copy' },
      reason: 'listing_copy_of_paid',
    });

    // The loader turns the copy line into rows for the copy's own file: $0.
    const sink = new MemorySink();
    const printed: string[] = [];
    const loaded = await runLoad(
      {
        mode: 'apply',
        ledgerDir: dirOf('d3'),
        accountId: ACCT,
        agencyDomains: [],
        unknownStartDates: [],
      },
      {
        loadRoster: async () => roster(),
        makeSink: async () => sink,
        repoRoots: [repo],
        print: (l) => printed.push(l),
      },
    );
    expect(loaded.exitCode).toBe(LOAD_EXIT.ok);
    expect([...sink.rows.values()].some((r) => r.file_id === 'file-copy')).toBe(true);
  });

  it('a brand-new file whose md5 matches a paid cell is not sent to the model', async () => {
    await runPilot(apply(dirOf('d1')), rig(listing()).io);
    const twin = cand({
      fileId: 'file-twin',
      name: 'Review qy',
      mimeType: GSLIDES,
      ancestors: ['root', 'Elsewhere [ACME88888888]'],
      accountId: ACCT,
      md5Checksum: 'md5-3',
      projectRef: { jobNumber: 'ACME88888888' },
    });
    const day2 = rig(listing({}, [twin]));
    // file-twin collapses into the listing's md5 group; the kept one (newest, tie by id) is whichever
    // the shortlist keeps: either way nothing needs a model call.
    const out = await runPilot(apply(dirOf('d2')), day2.io);
    expect(day2.llm.calls).toHaveLength(0);
    expect(out.incremental?.toPay).toHaveLength(0);
    expect(out.incremental?.carries.length).toBeGreaterThanOrEqual(1);
    expect(day2.makeLlm).not.toHaveBeenCalled();
  });

  it('a new extractor version (thinking level) selects every cell: the re-scan set', async () => {
    await runPilot(apply(dirOf('d1')), rig(listing()).io);
    const out = await runPilot(plan(dirOf('d2'), ['--thinking', 'MEDIUM']), rig(listing()).io);
    expect(out.incremental?.toPay).toHaveLength(5);
    expect(out.exitCode).toBe(PILOT_EXIT.dryRun);
  });
});

describe('ledgers of another account are never read', () => {
  it('a sibling written for another account does not count as paid', async () => {
    const other = rig(listing());
    const otherArgs = parsePilotArgs([
      '--account-id',
      '33333333-3333-4333-8333-333333333333',
      '--window-start',
      '2021-11-19',
      '--sample-seed',
      'incremental',
      '--incremental',
      '--sample-size',
      '10',
      '--apply',
      '--max-cells',
      '10',
      '--max-usd',
      '5',
      '--ledger-dir',
      dirOf('other'),
    ]);
    await runPilot(otherArgs, other.io);
    const mine = await runPilot(plan(dirOf('d1')), rig(listing()).io);
    expect(mine.incremental?.toPay).toHaveLength(5);
  });
});

describe('the paid-twice detector, by cell', () => {
  it('overlap mode flags a sibling that paid one of these cells, and only that', async () => {
    await runPilot(apply(dirOf('d1')), rig(listing()).io);
    const sig = {
      promptVersion: T3_PROMPT_VERSION,
      model: 'gemini-3.5-flash',
      thinkingLevel: 'LOW',
      capChars: PILOT_CAP_CHARS,
    };
    expect(extractorVersionOf(sig)).toBe(cellsOf(dirOf('d1'))[0]?.extractorVersion);
    const paidKey = cellKeyOf(listing()[0] as T3Candidate, sig);
    const args = apply(dirOf('d2'));
    expect(findPaidTwice(dirOf('d2'), args, { overlapWith: new Set([paidKey]) })).toBe('d1');
    expect(findPaidTwice(dirOf('d2'), args, { overlapWith: new Set(['unrelated']) })).toBeNull();
    // Without the option the same-configuration rule still flags it (non-incremental behaviour).
    expect(findPaidTwice(dirOf('d2'), args)).toBe('d1');
  });
});
