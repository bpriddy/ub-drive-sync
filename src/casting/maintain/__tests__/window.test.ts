/**
 * The sliding window (S9 task 5): the cutoff is recorded in every run report, and a slide moves
 * only what is selected from now on. It deletes nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRosterIndex } from '../../identity';
import { ROSTER } from '../../identity/__tests__/roster.fixture';
import { parseCastingArgs } from '../../run-all/args';
import { EXIT, runCasting } from '../../run-all/run';
import { fakes, records, ACCT } from '../../run-all/__tests__/helpers';
import { JsonlLedger } from '../../t3/ledger';
import { runLoad } from '../../t3/load';
import { runPilot, type PilotIo } from '../../t3/pilot';
import { parsePilotArgs } from '../../t3/pilot-args';
import { MemorySink, type T3Sink } from '../../t3/sink';
import type { T3Candidate } from '../../t3/types';
import { CREDITS_DECK, FakeLlm, GSLIDES, answer, cand } from '../../t3/__tests__/helpers';
import { WINDOW_YEARS_DEFAULT } from '../constants';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'window-test-'));
  fs.mkdirSync(path.join(tmp, 'repo'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the cutoff is recorded', () => {
  it('casting-run: the plan and the summary lines carry the resolved cutoff and the window length', async () => {
    const f = fakes();
    const args = parseCastingArgs(
      [
        '--account-id',
        ACCT,
        '--incremental',
        '--window-years',
        String(WINDOW_YEARS_DEFAULT),
        '--stages',
        't1',
      ],
      new Date('2026-11-24T00:00:00Z'),
    );
    const out = await runCasting(args, f.deps());
    expect(out.exitCode).toBe(EXIT.plan);
    const rec = records(f.lines);
    expect(rec.find((r) => r['msg'] === 'casting-run plan')).toMatchObject({
      windowCutoff: '2021-11-24',
      windowYears: 5,
    });
    expect(rec.find((r) => r['msg'] === 'casting-run summary')).toMatchObject({
      windowCutoff: '2021-11-24',
    });
  });

  it('the ledger loader stamps the ledger window start on its sync run', async () => {
    const repo = path.join(tmp, 'repo');
    const list: T3Candidate[] = [
      cand({
        fileId: 'f1',
        name: 'Review qa',
        mimeType: GSLIDES,
        ancestors: ['root', 'Folder qa'],
        accountId: ACCT,
      }),
    ];
    const io: PilotIo = {
      loadCandidates: async () => list,
      loadRoster: async () => buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] }),
      makeReader: () => ({
        async read() {
          return { kind: 'ok' as const, text: CREDITS_DECK };
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
      now: new Date('2026-11-24T00:00:00Z'),
    };
    const dir = path.join(tmp, 'ledgers', 'd1');
    await runPilot(
      parsePilotArgs([
        '--account-id',
        ACCT,
        '--window-start',
        '2021-11-24',
        '--sample-seed',
        's',
        '--sample-size',
        '5',
        '--apply',
        '--max-cells',
        '5',
        '--max-usd',
        '5',
        '--ledger-dir',
        dir,
      ]),
      io,
    );
    const started: Record<string, unknown>[] = [];
    const inner = new MemorySink();
    const sink: T3Sink = {
      startRun: async (info) => (started.push({ ...(info.details ?? {}) }), inner.startRun()),
      writeEvidence: (id, rows) => inner.writeEvidence(id, rows),
      finishRun: (id, o) => inner.finishRun(id, o),
    };
    await runLoad(
      { mode: 'apply', ledgerDir: dir, accountId: ACCT, agencyDomains: [], unknownStartDates: [] },
      {
        loadRoster: async () =>
          buildRosterIndex(ROSTER, { agencyEmailDomains: ['agency.example'] }),
        makeSink: async () => sink,
        repoRoots: [repo],
        print: () => undefined,
      },
    );
    expect(started[0]).toMatchObject({ mode: 'ledger_load', window_start: '2021-11-24' });
  });
});

describe('the slide deletes nothing', () => {
  it('no maintenance code path deletes evidence because of the window (only the explicit purge deletes)', () => {
    const dir = path.resolve(__dirname, '..');
    const writers = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        /\bDELETE\b/.test(
          fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
        ),
      );
    expect(writers).toEqual(['purge-pg.ts']);
  });
});
