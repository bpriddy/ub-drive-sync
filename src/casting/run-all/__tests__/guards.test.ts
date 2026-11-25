import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardError, PILOT_HEADER_FILE } from '../../t3/ledger';
import { signatureOf } from '../../t3/pilot';
import { parsePilotArgs, type PilotArgs } from '../../t3/pilot-args';
import {
  acquireLock,
  checkBeforeApply,
  checkLedgerOutside,
  checkModelEnv,
  checkModelPriced,
  findPaidTwice,
  fusionPinReminder,
  lockPathOf,
} from '../guards';
import { ACCT, WINDOW, tmpDir } from './helpers';

let tmp: string;
beforeEach(() => {
  tmp = tmpDir();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const pilot = (seed = 'seed-a', extra: string[] = []): PilotArgs =>
  parsePilotArgs([
    '--account-id',
    ACCT,
    '--window-start',
    WINDOW,
    '--sample-size',
    '50',
    '--sample-seed',
    seed,
    ...extra,
  ]);

describe('model preflight (fail closed on the mock)', () => {
  it('needs GEMINI_USE_ENTERPRISE=true and a project; an API key alone is refused', () => {
    expect(() =>
      checkModelEnv({ GEMINI_USE_ENTERPRISE: 'true', GCP_PROJECT_ID: 'p' }),
    ).not.toThrow();
    expect(() => checkModelEnv({ GCP_PROJECT_ID: 'p' })).toThrow(/GEMINI_USE_ENTERPRISE=true/);
    expect(() => checkModelEnv({ GEMINI_USE_ENTERPRISE: 'false', GCP_PROJECT_ID: 'p' })).toThrow(
      /GEMINI_USE_ENTERPRISE=true/,
    );
    expect(() => checkModelEnv({ GEMINI_USE_ENTERPRISE: 'true' })).toThrow(/GCP_PROJECT_ID/);
    expect(() => checkModelEnv({ GEMINI_USE_ENTERPRISE: 'true', GCP_PROJECT_ID: '  ' })).toThrow(
      GuardError,
    );
    expect(() => checkModelEnv({ GEMINI_API_KEY: 'k' })).toThrow(/API-key-only/);
  });

  it('a model without a price is refused', () => {
    expect(() => checkModelPriced('gemini-3.5-flash')).not.toThrow();
    expect(() => checkModelPriced('gemini-9-unknown')).toThrow(/no price/);
  });
});

describe('ledger location', () => {
  it('a ledger inside a repo root is refused; outside is resolved', () => {
    expect(() => checkLedgerOutside(path.join(tmp, 'in'), [tmp])).toThrow(GuardError);
    expect(checkLedgerOutside(path.join(tmp, 'out'), ['/repo-that-does-not-exist'])).toBe(
      path.join(tmp, 'out'),
    );
  });
});

describe('--expect-cells and the base estimate', () => {
  const info = { cells: 50, model: 'gemini-3.5-flash', baseCostUsd: 2, baseComplete: true };
  it('passes when the cells match and the base estimate fits the cap', () => {
    expect(() => checkBeforeApply(info, { expectCells: 50, maxUsd: 5 })).not.toThrow();
    expect(() => checkBeforeApply(info, { expectCells: 50, maxUsd: 2 })).not.toThrow();
  });
  it('refuses a cell count that differs from the PROPOSAL the person saw', () => {
    expect(() => checkBeforeApply({ ...info, cells: 49 }, { expectCells: 50, maxUsd: 5 })).toThrow(
      /--expect-cells is 50/,
    );
  });
  it('refuses when the base estimate is above the cap, or has no price', () => {
    expect(() => checkBeforeApply(info, { expectCells: 50, maxUsd: 1.99 })).toThrow(
      /above --max-usd/,
    );
    expect(() =>
      checkBeforeApply({ ...info, baseCostUsd: null }, { expectCells: 50, maxUsd: 5 }),
    ).toThrow(/no price/);
  });
});

describe('lock next to the ledger directory', () => {
  it('excludes a second holder, is removed on release, lives outside the ledger dir', () => {
    const dir = path.join(tmp, 'ledger');
    const now = new Date('2026-11-20T00:00:00Z');
    const release = acquireLock(dir, now, () => true);
    expect(fs.existsSync(lockPathOf(dir))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => acquireLock(dir, now, () => true)).toThrow(/holds/);
    release();
    expect(fs.existsSync(lockPathOf(dir))).toBe(false);
    acquireLock(dir, now, () => true)();
  });

  it('replaces a stale lock (dead pid) and an unreadable one', () => {
    const dir = path.join(tmp, 'ledger');
    const now = new Date('2026-11-20T00:00:00Z');
    fs.writeFileSync(lockPathOf(dir), JSON.stringify({ pid: 999999, startedAt: 'x' }));
    const release = acquireLock(dir, now, () => false);
    release();
    fs.writeFileSync(lockPathOf(dir), 'not json');
    acquireLock(dir, now, () => true)();
    expect(fs.existsSync(lockPathOf(dir))).toBe(false);
  });
});

describe('paid-twice detector', () => {
  function sibling(
    name: string,
    signature: Record<string, string | number>,
    status: string | null,
  ) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, PILOT_HEADER_FILE), JSON.stringify({ v: 1, signature }));
    if (status !== null) {
      fs.writeFileSync(
        path.join(d, 'cells.jsonl'),
        JSON.stringify({ v: 1, status }) + '\n{"torn":\n',
      );
    }
    return d;
  }

  it('finds a sibling with the same account and configuration and an ok cell', () => {
    const mine = pilot('seed-a');
    sibling('earlier', { ...signatureOf(pilot('seed-b')) }, 'ok');
    expect(findPaidTwice(path.join(tmp, 'now'), mine)).toBe('earlier');
  });

  it('ignores an empty ledger, a failed-only ledger, another configuration, another account', () => {
    const mine = pilot('seed-a');
    sibling('empty', { ...signatureOf(pilot('s1')) }, null);
    sibling('failed', { ...signatureOf(pilot('s2')) }, 'failed');
    sibling(
      'other-model',
      { ...signatureOf(pilot('s3', ['--model', 'gemini-3.5-flash-lite'])) },
      'ok',
    );
    sibling('other-thinking', { ...signatureOf(pilot('s4', ['--thinking', 'MINIMAL'])) }, 'ok');
    sibling('other-acct', { ...signatureOf(pilot('s5')), accountId: 'something-else' }, 'ok');
    fs.writeFileSync(path.join(tmp, 'a-file.txt'), 'x');
    expect(findPaidTwice(path.join(tmp, 'now'), mine)).toBeNull();
  });

  it('the directory itself is a resume, not a twin; a missing parent is fine', () => {
    const mine = pilot('seed-a');
    sibling('same', { ...signatureOf(mine) }, 'ok');
    expect(findPaidTwice(path.join(tmp, 'same'), mine)).toBeNull();
    expect(findPaidTwice(path.join(tmp, 'no', 'such', 'dir'), mine)).toBeNull();
  });
});

describe('fusion version pin reminder', () => {
  it('speaks only when a pin is set and differs from the code', () => {
    expect(fusionPinReminder({})).toBeNull();
    expect(fusionPinReminder({ STAFF_WORK_BUILD_VERSION: 'fusion-v4' })).toBeNull();
    expect(fusionPinReminder({ STAFF_WORK_BUILD_VERSION: 'fusion-v0' })).toMatch(/fusion-v0/);
    // the casting pin is retired with experience (D44): it no longer speaks
    expect(fusionPinReminder({ CASTING_FUSION_VERSION: 'fusion-v0' })).toBeNull();
  });
});
