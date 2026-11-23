import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRosterIndex } from '../../identity';
import { JsonlLedger } from '../../t3/ledger';
import { runPilot, type PilotIo } from '../../t3/pilot';
import { parsePilotArgs } from '../../t3/pilot-args';
import { MemorySink } from '../../t3/sink';
import type { T3Candidate } from '../../t3/types';
import { CREDITS_DECK, FakeLlm, GSLIDES, answer, cand } from '../../t3/__tests__/helpers';
import { parseRescanArgs, runRescanPlan } from '../rescan-plan';

const ACCT = '11111111-1111-4111-8111-111111111111';
let tmp: string;
let repo: string;
let ledgers: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rescan-test-'));
  repo = path.join(tmp, 'repo');
  ledgers = path.join(tmp, 'ledgers');
  fs.mkdirSync(repo);
  fs.mkdirSync(ledgers);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const files = (n: number): T3Candidate[] =>
  Array.from({ length: n }, (_, i) =>
    cand({
      fileId: `file-${i}`,
      name: `Review q${'abcdefgh'[i]}`,
      mimeType: GSLIDES,
      ancestors: ['root', `Folder q${'abcdefgh'[i]}`],
      accountId: ACCT,
      md5Checksum: `md5-${i}`,
    }),
  );

/** One earlier paid ledger (fake model) under gemini-3.5-flash / LOW. */
async function paidLedger(list: T3Candidate[]): Promise<void> {
  const io: PilotIo = {
    loadCandidates: async () => list,
    loadRoster: async () => buildRosterIndex([]),
    makeReader: () => ({
      async read(c: T3Candidate) {
        // Distinct text per file: identical text would be a read-time copy, not a paid cell.
        return { kind: 'ok' as const, text: `${CREDITS_DECK}\n\n${c.fileId}` };
      },
    }),
    makeLlm: async () =>
      new FakeLlm(() =>
        answer('credits_or_team', [
          {
            raw_name: 'Jürgen Falkenrath',
            raw_role: 'Creative Director',
            quote: 'Creative Director: Jürgen Falkenrath',
          },
        ]),
      ),
    makeSink: () => new MemorySink(),
    openLedger: (d) => new JsonlLedger(d, repo),
    repoRoots: [repo],
    print: () => undefined,
  };
  await runPilot(
    parsePilotArgs([
      '--account-id',
      ACCT,
      '--window-start',
      '2021-11-19',
      '--sample-seed',
      's',
      '--sample-size',
      '20',
      '--apply',
      '--max-cells',
      '20',
      '--max-usd',
      '5',
      '--ledger-dir',
      path.join(ledgers, 'd1'),
    ]),
    io,
  );
}

const rescanArgv = (...extra: string[]) => [
  '--account-id',
  ACCT,
  '--window-start',
  '2021-11-19',
  '--ledger-dir',
  path.join(ledgers, 'd2'),
  ...extra,
];

async function plan(list: T3Candidate[], ...extra: string[]) {
  const printed: string[] = [];
  const report = await runRescanPlan(parseRescanArgs(rescanArgv(...extra)), {
    loadCandidates: async () => list,
    repoRoot: repo,
    print: (l) => printed.push(l),
  });
  return { report, printed };
}

describe('parseRescanArgs: nothing here can start a paid run', () => {
  it('refuses every apply flag and unknown flags', () => {
    expect(() => parseRescanArgs(rescanArgv('--apply'))).toThrow(/never runs the model/);
    expect(() => parseRescanArgs(rescanArgv('--apply-t3'))).toThrow(/never runs the model/);
    expect(() => parseRescanArgs(rescanArgv('--max-usd', '5'))).toThrow(/unknown flag/);
    expect(() => parseRescanArgs(rescanArgv('--sample-size', '5'))).toThrow(/unknown flag/);
  });
  it('needs an absolute ledger dir and takes the pilot defaults for the arm', () => {
    expect(() => parseRescanArgv(['--account-id', ACCT, '--window-start', '2021-11-19'])).toThrow();
    expect(parseRescanArgs(rescanArgv())).toMatchObject({
      model: 'gemini-3.5-flash',
      thinkingLevel: 'LOW',
      variant: 'base',
    });
  });
});

function parseRescanArgv(argv: string[]) {
  return parseRescanArgs(argv);
}

describe('runRescanPlan', () => {
  it('a thinking-level bump needs every cell again, counted as re-extraction, with a cost', async () => {
    await paidLedger(files(5));
    const { report, printed } = await plan(files(6), '--thinking', 'MEDIUM');
    expect(report).toMatchObject({
      targetVersion: 't3-v1:gemini-3.5-flash:medium',
      earlierLedgers: 1,
      earlierVersions: { 't3-v1:gemini-3.5-flash:low': 5 },
      shortlist: 6,
      alreadyDone: 0,
      toPay: 6,
      reExtraction: 5,
      neverExtracted: 1,
    });
    expect(report.baseCostUsd).toBeGreaterThan(0);
    const text = printed.join('\n');
    expect(text).toMatch(/^PROPOSAL \(no run started\)/);
    expect(text).toContain('nothing was run');
    expect(text).toContain('[ASSUME 10000]');
    expect(text).toContain('needs its own approval');
  });

  it('the same version needs only the new file; a quiet account needs nothing', async () => {
    await paidLedger(files(5));
    expect((await plan(files(6))).report).toMatchObject({
      alreadyDone: 5,
      toPay: 1,
      reExtraction: 0,
    });
    const quiet = await plan(files(5));
    expect(quiet.report.toPay).toBe(0);
    expect(quiet.printed.join('\n')).toContain('nothing to re-scan');
  });

  it('writes nothing and creates no ledger directory', async () => {
    await paidLedger(files(3));
    const before = fs.readdirSync(ledgers).sort();
    await plan(files(3), '--thinking', 'HIGH');
    expect(fs.readdirSync(ledgers).sort()).toEqual(before);
    expect(fs.existsSync(path.join(ledgers, 'd2'))).toBe(false);
  });
});
