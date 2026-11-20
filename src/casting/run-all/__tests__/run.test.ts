import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardError, PILOT_HEADER_FILE } from '../../t3/ledger';
import { signatureOf } from '../../t3/pilot';
import { parsePilotArgs } from '../../t3/pilot-args';
import { runCastingCli } from '../main';
import { EXIT, runCasting } from '../run';
import { lockPathOf, runLogPathOf } from '../guards';
import {
  ACCT,
  GOOD_ENV,
  PLAN_FLAGS,
  WINDOW,
  castingArgs,
  fakes,
  paidFlags,
  records,
  tmpDir,
  type Fakes,
} from './helpers';

let tmp: string;
let ledger: string;
let f: Fakes;
beforeEach(() => {
  tmp = tmpDir();
  ledger = path.join(tmp, 'ledgers', 'one');
  f = fakes();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const stagesCalled = (): string[] => f.calls.map((c) => c.stage);
const summary = (): Record<string, unknown> =>
  records(f.lines).find((r) => r['msg'] === 'casting-run summary') as Record<string, unknown>;

describe('PLAN (the default)', () => {
  it('runs every stage as a dry-run in the fixed order, applies nothing, exits 3', async () => {
    const out = await runCasting(castingArgs(), f.deps());
    expect(out.exitCode).toBe(EXIT.plan);
    expect(stagesCalled()).toEqual(['t1', 't2', 't3', 'fusion']);
    for (const c of f.calls) expect(c.argv).not.toContain('--apply');
    expect(out.results.map((r) => `${r.stage}:${r.status}`)).toEqual([
      't1:ok',
      't2:ok',
      't3:ok',
      'load:skipped',
      'fusion:ok',
    ]);
    expect(summary()).toMatchObject({ mode: 'plan', exitCode: 3, decidedBy: null });
  });

  it('--stages keeps the fixed order whatever was typed', async () => {
    await runCasting(castingArgs('--stages', 'fusion,t2,t1'), f.deps());
    expect(stagesCalled()).toEqual(['t1', 't2', 'fusion']);
  });

  it('load dry-runs only when the ledger already has a header', async () => {
    const args = castingArgs('--ledger-dir', ledger);
    await runCasting(args, f.deps());
    expect(stagesCalled()).not.toContain('load');
    f.calls.length = 0;
    fs.mkdirSync(ledger, { recursive: true });
    fs.writeFileSync(path.join(ledger, PILOT_HEADER_FILE), '{}');
    await runCasting(args, f.deps());
    expect(stagesCalled()).toContain('load');
    expect(f.calls.find((c) => c.stage === 'load')!.argv).not.toContain('--apply');
  });

  it('stage codes 0 and 3 are both ok in a PLAN; the agency domains are applied once, merged with env', async () => {
    f.codes = { t3: 3, t1: 0 };
    const out = await runCasting(
      castingArgs('--agency-domain', 'b.example'),
      f.deps({ env: { CASTING_AGENCY_EMAIL_DOMAINS: 'a.example' } }),
    );
    expect(out.exitCode).toBe(EXIT.plan);
    expect(f.domainsApplied).toEqual(['a.example,b.example']);
  });

  it('a bad flag is refused (2) before any stage is called', async () => {
    const out = await runCasting(castingArgs('--parallel', '9'), f.deps());
    expect(out.exitCode).toBe(EXIT.refused);
    expect(f.calls).toHaveLength(0);
    expect(summary()).toMatchObject({ exitCode: 2, decidedBy: 'preflight' });
  });

  it('warns when the fusion pin differs from the code version', async () => {
    await runCasting(castingArgs(), f.deps({ env: { CASTING_FUSION_VERSION: 'fusion-v0' } }));
    const plan = records(f.lines).find((r) => r['msg'] === 'casting-run plan')!;
    expect(String(plan['warning'])).toMatch(/fusion-v0/);
  });
});

describe('--apply without --apply-t3', () => {
  it('writes in t1, t2, load, fusion and never applies t3', async () => {
    fs.mkdirSync(ledger, { recursive: true });
    fs.writeFileSync(path.join(ledger, PILOT_HEADER_FILE), '{}');
    const out = await runCasting(castingArgs('--apply', '--ledger-dir', ledger), f.deps());
    expect(out.exitCode).toBe(EXIT.ok);
    expect(stagesCalled()).toEqual(['t1', 't2', 't3', 'load', 'fusion']);
    for (const c of f.calls) {
      expect(c.argv.includes('--apply'), c.stage).toBe(c.stage !== 't3');
    }
    expect(f.calls.find((c) => c.stage === 't3')!.argv).not.toContain('--max-usd');
    // no lock or audit file for a free run
    expect(fs.existsSync(lockPathOf(ledger))).toBe(false);
    expect(fs.existsSync(runLogPathOf(ledger))).toBe(false);
  });

  it('refuses before starting when load is applied and the ledger has no header', async () => {
    const out = await runCasting(castingArgs('--apply', '--ledger-dir', ledger), f.deps());
    expect(out.exitCode).toBe(EXIT.refused);
    expect(f.calls).toHaveLength(0);
  });
});

describe('fail-fast and exit codes', () => {
  it('a failing T1 means the T3 fake is never called; exit 1, decided by t1', async () => {
    f.codes = { t1: 1 };
    const out = await runCasting(castingArgs(), f.deps());
    expect(out).toMatchObject({ exitCode: 1, decidedBy: 't1' });
    expect(stagesCalled()).toEqual(['t1']);
    expect(out.results.map((r) => r.status)).toEqual([
      'failed',
      'not_run',
      'not_run',
      'not_run',
      'not_run',
    ]);
  });

  it('maps 2, 4 and 75 to themselves and any other code to 1', async () => {
    for (const [code, want] of [
      [2, 2],
      [4, 4],
      [75, 75],
      [9, 1],
    ] as const) {
      f = fakes();
      f.codes = { t2: code };
      const out = await runCasting(castingArgs(), f.deps());
      expect(out.exitCode, String(code)).toBe(want);
      expect(out.decidedBy).toBe('t2');
      expect(stagesCalled()).toEqual(['t1', 't2']);
    }
  });

  it('exit 3 from a stage that was applied is not ok', async () => {
    f.codes = { t1: 3 };
    const out = await runCasting(castingArgs('--apply', '--stages', 't1,fusion'), f.deps());
    expect(out).toMatchObject({ exitCode: 1, decidedBy: 't1' });
  });

  it('a thrown GuardError is 2 and any other throw is 1; the message is one line', async () => {
    f.codes = { t1: new GuardError('refused here\nsecond line') };
    expect((await runCasting(castingArgs(), f.deps())).exitCode).toBe(2);
    expect(JSON.stringify(f.lines)).not.toContain('second line');
    f = fakes();
    f.codes = { t1: new Error('boom') };
    expect((await runCasting(castingArgs(), f.deps())).exitCode).toBe(1);
  });
});

describe('--apply-t3 (the paid stage; fakes only)', () => {
  const paid = (...extra: string[]) => castingArgs(...paidFlags(ledger, extra));
  const okInfo = { cells: 50, model: 'gemini-3.5-flash', baseCostUsd: 2, baseComplete: true };

  it('refuses without the model environment: nothing runs, no lock, no log', async () => {
    for (const env of [{}, { GEMINI_API_KEY: 'k' }, { GEMINI_USE_ENTERPRISE: 'true' }]) {
      f = fakes();
      const out = await runCasting(paid(), f.deps({ env }));
      expect(out).toMatchObject({ exitCode: EXIT.refused, decidedBy: 'preflight' });
      expect(f.calls).toHaveLength(0);
      expect(fs.existsSync(lockPathOf(ledger))).toBe(false);
    }
  });

  it('refuses an unpriced model and a ledger inside the checkout', async () => {
    let out = await runCasting(paid('--model', 'gemini-9-unknown'), f.deps({ env: GOOD_ENV }));
    expect(out.exitCode).toBe(EXIT.refused);
    out = await runCasting(paid(), f.deps({ env: GOOD_ENV, repoRoots: [tmp] }));
    expect(out.exitCode).toBe(EXIT.refused);
    expect(f.calls).toHaveLength(0);
  });

  it('runs t3 -> load -> fusion with --apply; the audit log and lock sit next to the ledger dir', async () => {
    f.t3Info = okInfo;
    const out = await runCasting(
      castingArgs('--apply', ...paidFlags(ledger)),
      f.deps({ env: GOOD_ENV }),
    );
    expect(out.exitCode).toBe(EXIT.ok);
    expect(stagesCalled()).toEqual(['t1', 't2', 't3', 'load', 'fusion']);
    expect(f.calls.find((c) => c.stage === 't3')!.argv).toEqual(
      expect.arrayContaining(['--apply', '--max-cells', '50', '--max-usd', '5']),
    );
    expect(fs.existsSync(lockPathOf(ledger))).toBe(false); // released
    expect(fs.existsSync(ledger)).toBe(false); // nothing was written inside the ledger dir
    const audit = fs.readFileSync(runLogPathOf(ledger), 'utf8').trim().split('\n');
    expect(audit.length).toBeGreaterThan(5);
    expect(audit.map((l) => (JSON.parse(l) as { msg: string }).msg)).toContain(
      'casting-run summary',
    );
  });

  it('--apply-t3 alone runs the paid stage only as apply; the free stages stay dry-runs', async () => {
    f.t3Info = okInfo;
    const out = await runCasting(paid('--stages', 't1,t3'), f.deps({ env: GOOD_ENV }));
    expect(out.exitCode).toBe(EXIT.ok);
    expect(f.calls.find((c) => c.stage === 't1')!.argv).not.toContain('--apply');
    expect(f.calls.find((c) => c.stage === 't3')!.argv).toContain('--apply');
  });

  it('refuses at the stage when --expect-cells differs from the PROPOSAL; nothing after it runs', async () => {
    f.t3Info = { ...okInfo, cells: 49 };
    const out = await runCasting(paid(), f.deps({ env: GOOD_ENV }));
    expect(out).toMatchObject({ exitCode: EXIT.refused, decidedBy: 't3' });
    expect(stagesCalled()).toEqual(['t1', 't2', 't3']);
    expect(fs.existsSync(lockPathOf(ledger))).toBe(false);
  });

  it('refuses when the base estimate is above --max-usd', async () => {
    f.t3Info = { ...okInfo, baseCostUsd: 5.01 };
    const out = await runCasting(paid(), f.deps({ env: GOOD_ENV }));
    expect(out).toMatchObject({ exitCode: EXIT.refused, decidedBy: 't3' });
  });

  it('halts on exit 4 (cost ceiling): load and fusion do not run on a partial ledger', async () => {
    f.t3Info = okInfo;
    f.codes = { t3: 4 };
    const out = await runCasting(
      castingArgs('--apply', ...paidFlags(ledger)),
      f.deps({ env: GOOD_ENV }),
    );
    expect(out).toMatchObject({ exitCode: EXIT.stopped, decidedBy: 't3' });
    expect(stagesCalled()).toEqual(['t1', 't2', 't3']);
    expect(fs.existsSync(lockPathOf(ledger))).toBe(false);
    expect(summary()).toMatchObject({ exitCode: 4, decidedBy: 't3' });
  });

  it('a held lock refuses the run before any stage; the other holder keeps its lock', async () => {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(lockPathOf(ledger), JSON.stringify({ pid: 4242 }));
    const out = await runCasting(paid(), f.deps({ env: GOOD_ENV, isPidAlive: () => true }));
    expect(out).toMatchObject({ exitCode: EXIT.refused, decidedBy: 'preflight' });
    expect(f.calls).toHaveLength(0);
    expect(fs.existsSync(lockPathOf(ledger))).toBe(true);
  });

  it('paid-twice: a sibling ledger that already paid refuses unless --allow-repeat-paid', async () => {
    const mine = parsePilotArgs([
      '--account-id',
      ACCT,
      '--window-start',
      WINDOW,
      '--sample-size',
      '50',
      '--sample-seed',
      'other-seed',
    ]);
    const old = path.join(path.dirname(ledger), 'earlier');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(
      path.join(old, PILOT_HEADER_FILE),
      JSON.stringify({ v: 1, signature: signatureOf(mine) }),
    );
    fs.writeFileSync(path.join(old, 'cells.jsonl'), JSON.stringify({ v: 1, status: 'ok' }) + '\n');

    const refused = await runCasting(paid(), f.deps({ env: GOOD_ENV }));
    expect(refused).toMatchObject({ exitCode: EXIT.refused, decidedBy: 'preflight' });
    expect(f.calls).toHaveLength(0);
    expect(f.lines.join('\n')).toMatch(/already paid/);

    f.t3Info = okInfo;
    const allowed = await runCasting(
      paid('--allow-repeat-paid', '--stages', 't3'),
      f.deps({ env: GOOD_ENV }),
    );
    expect(allowed.exitCode).toBe(EXIT.ok);
  });

  it('the plan line names the extractor version of the arm that would run', async () => {
    f.t3Info = okInfo;
    await runCasting(paid('--stages', 't3'), f.deps({ env: GOOD_ENV }));
    const plan = records(f.lines).find((r) => r['msg'] === 'casting-run plan')!;
    expect(String(plan['t3ExtractorVersion'])).toMatch(/^t3-.+:gemini-3\.5-flash:low$/);
  });
});

describe('logging is counts only', () => {
  it('no log line carries the account id, the seed, a path or the domains', async () => {
    f.t3Info = { cells: 50, model: 'gemini-3.5-flash', baseCostUsd: 2, baseComplete: true };
    await runCasting(
      castingArgs('--apply', '--agency-domain', 'agency.example', ...paidFlags(ledger)),
      f.deps({ env: GOOD_ENV }),
    );
    const all = f.lines.join('\n') + fs.readFileSync(runLogPathOf(ledger), 'utf8');
    for (const secret of [ACCT, 'seed-a', 'agency.example', tmp]) {
      expect(all.includes(secret), secret).toBe(false);
    }
  });
});

describe('runCastingCli', () => {
  it('turns an argument error into exit 2 and a REFUSED line, with no stage called', async () => {
    const errors: string[] = [];
    const code = await runCastingCli(['--aply'], f.deps(), (l) => errors.push(l));
    expect(code).toBe(2);
    expect(errors[0]).toMatch(/^REFUSED: unknown flag --aply/);
    expect(f.calls).toHaveLength(0);
  });

  it('a PLAN through the CLI exits 3', async () => {
    expect(await runCastingCli(PLAN_FLAGS, f.deps(), () => {})).toBe(3);
  });
});
