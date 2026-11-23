import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  cellKeyOf,
  copyCellKeyOf,
  type CellConfigSignature,
  type CellRecord,
} from '../../t3/ledger';
import { selectCandidates } from '../../t3/triage';
import { GSLIDES, cand } from '../../t3/__tests__/helpers';
import { doneKeysOf, planIncremental } from '../incremental';
import { CARRIED_REASON, ChainedLedger, readPriorLedgers } from '../prior-ledgers';

const SIG: CellConfigSignature = {
  promptVersion: 'v1',
  model: 'gemini-3.5-flash',
  thinkingLevel: 'LOW',
  capChars: 40_000,
};
const VERSION = 't3-v1:gemini-3.5-flash:low';

const file = (id: string, letter: string, md5: string | null) =>
  cand({
    fileId: id,
    name: `Review q${letter}`,
    mimeType: GSLIDES,
    ancestors: ['root', `Folder q${letter}`],
    md5Checksum: md5,
  });

function record(
  c: ReturnType<typeof file>,
  status: CellRecord['status'],
  over: Partial<CellRecord> = {},
): CellRecord {
  return {
    v: 1,
    cellKey: cellKeyOf(c, SIG),
    extractorVersion: VERSION,
    at: '2026-11-01T00:00:00.000Z',
    status,
    reason: null,
    candidate: {
      fileId: c.fileId,
      accountId: c.accountId,
      createdTime: c.createdTime,
      md5Checksum: c.md5Checksum,
    },
    docClass: 'gslides',
    contentHash: null,
    docType: null,
    truncated: false,
    sentChars: null,
    attempts: 1,
    usage: null,
    mentions: [],
    sanitizeStats: null,
    groundingStats: null,
    ...over,
  };
}

const select = (files: ReturnType<typeof file>[]) =>
  selectCandidates(files, { windowStart: '2021-01-01' });

describe('doneKeysOf: the stage rule, across ledgers', () => {
  it('ok, skipped and copy are done; failed is done unless retried', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((l, i) => file(`f${i}`, l, `m${i}`));
    const recs = [
      record(a!, 'ok'),
      record(b!, 'skipped'),
      record(c!, 'copy'),
      record(d!, 'failed'),
    ];
    expect(doneKeysOf(recs, false).done.size).toBe(4);
    expect(doneKeysOf(recs, true).done.size).toBe(3);
    expect(doneKeysOf(recs, true).failed.size).toBe(1);
  });
});

describe('planIncremental', () => {
  it('no prior ledger: everything is paid', () => {
    const files = [file('f1', 'a', 'm1'), file('f2', 'b', 'm2')];
    const plan = planIncremental(select(files), SIG, []);
    expect(plan.toPay).toHaveLength(2);
    expect(plan.carries).toEqual([]);
  });

  it('a failed cell is not re-paid by default, and is selected with retryFailed', () => {
    const f = file('f1', 'a', 'm1');
    const prior = [record(f, 'failed')];
    expect(planIncremental(select([f]), SIG, prior).toPay).toHaveLength(0);
    const retry = planIncremental(select([f]), SIG, prior, { retryFailed: true });
    expect(retry.toPay).toHaveLength(1);
    expect(retry.retried).toBe(1);
  });

  it('an edited file (new md5) is a new cell; a Google-native file uses its modified time', () => {
    const before = file('f1', 'a', 'm1');
    const after = file('f1', 'a', 'm1-edited');
    expect(planIncremental(select([after]), SIG, [record(before, 'ok')]).toPay).toHaveLength(1);
    const native = (t: string) => ({ ...file('g1', 'b', null), modifiedTime: t });
    const prior = [record(native('2025-03-10T09:00:00.000Z') as never, 'ok')];
    expect(
      planIncremental(select([native('2025-03-10T09:00:00.000Z')]), SIG, prior).toPay,
    ).toHaveLength(0);
    expect(
      planIncremental(select([native('2025-04-01T09:00:00.000Z')]), SIG, prior).toPay,
    ).toHaveLength(1);
  });

  it('a record under another extractor signature never counts as done', () => {
    const f = file('f1', 'a', 'm1');
    const other = { ...SIG, model: 'gemini-3.5-flash-lite' };
    const prior = [
      record(f, 'ok', {
        cellKey: cellKeyOf(f, other),
        extractorVersion: 't3-v1:gemini-3.5-flash-lite:low',
      }),
    ];
    expect(planIncremental(select([f]), SIG, prior).toPay).toHaveLength(1);
  });

  it('does not add a copy line twice once the prior ledger holds it', () => {
    const kept = file('f1', 'a', 'm1');
    const copy = {
      ...file('f1b', 'b', 'm1'),
      ancestors: ['root', 'Other'],
      projectRef: { jobNumber: 'J1' },
    };
    const first = planIncremental(select([kept, copy]), SIG, [record(kept, 'ok')]);
    expect(first.carries).toHaveLength(1);
    const keyOfCopy = copyCellKeyOf(cellKeyOf(kept, SIG), 'f1b');
    const prior = [record(kept, 'ok'), record(copy, 'copy', { cellKey: keyOfCopy })];
    expect(planIncremental(select([kept, copy]), SIG, prior).carries).toEqual([]);
  });
});

describe('readPriorLedgers and ChainedLedger', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-test-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads siblings of the same account only, never the directory itself, and creates nothing', () => {
    const write = (name: string, account: string) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'header.json'),
        JSON.stringify({ v: 1, signature: { accountId: account } }),
      );
      fs.writeFileSync(
        path.join(dir, 'cells.jsonl'),
        JSON.stringify(record(file(name, 'a', 'm'), 'ok')) + '\n',
      );
    };
    write('d1', 'ACCT-A');
    write('d2', 'acct-a');
    write('d3', 'acct-b');
    fs.mkdirSync(path.join(tmp, 'no-header'));
    const target = path.join(tmp, 'd4');
    const out = readPriorLedgers(target, 'acct-a', '/not-the-repo');
    expect(out.ledgers).toBe(2);
    expect(out.skipped).toBe(1);
    expect(out.records).toHaveLength(2);
    expect(fs.existsSync(target)).toBe(false);
    expect(readPriorLedgers(path.join(tmp, 'd1'), 'acct-a', '/x').ledgers).toBe(1);
  });

  it('fails closed on a sibling ledger it cannot read: guessing "nothing paid" would pay twice', () => {
    const bad = path.join(tmp, 'bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'header.json'), '{ not json');
    expect(() => readPriorLedgers(path.join(tmp, 'd9'), 'acct-a', '/x')).toThrow(
      /unreadable header/,
    );
    fs.writeFileSync(path.join(bad, 'header.json'), JSON.stringify({ v: 2, signature: {} }));
    expect(() => readPriorLedgers(path.join(tmp, 'd9'), 'acct-a', '/x')).toThrow(
      /unknown header format/,
    );
  });

  it('writes only to its own ledger; a copy of a prior kept cell carries a cost-free clone once', () => {
    const kept = file('f1', 'a', 'm1');
    const paid = record(kept, 'ok', {
      usage: { promptTokens: 1, outputTokens: 1, thoughtsTokens: 0, costUsd: 0.01 },
    });
    const own = new MemoryLedger();
    const chained = new ChainedLedger([paid], own);
    expect(chained.load()).toHaveLength(1);
    const copyRec = (id: string) =>
      record(file(id, 'b', 'm1'), 'copy', { cellKey: `copy-${id}`, copyOfCellKey: paid.cellKey });
    chained.append(copyRec('c1'));
    chained.append(copyRec('c2'));
    expect(own.records.map((r) => [r.status, r.reason])).toEqual([
      ['ok', CARRIED_REASON],
      ['copy', null],
      ['copy', null],
    ]);
    expect(own.records[0]?.usage).toBeNull();
    expect(chained.load()).toHaveLength(4);
  });
});
