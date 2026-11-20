import { describe, expect, it } from 'vitest';
import { fitToCap } from '../truncate';
import { ASSUMPTION_PRESETS, PRESETS_CALIBRATION, estimate, estimateAll } from '../estimate';
import { costUsd, priceOf } from '../pricing';
import { UsageTally } from '../usage';
import { buildPrompt, promptOverheadChars } from '../prompt';
import { formatProposal } from '../proposal';
import { usage } from './helpers';

const CAP = 2000;

describe('fitToCap', () => {
  it('leaves a short text untouched', () => {
    const r = fitToCap('hello', 'gdoc', CAP);
    expect(r).toMatchObject({ text: 'hello', truncated: false, originalChars: 5, sentChars: 5 });
  });

  it('keeps the head and the tail of a long document and says the middle is gone', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
    const text = lines.join('\n');
    const r = fitToCap(text, 'gslides', CAP);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(CAP);
    expect(r.text).toContain('line 0 ');
    expect(r.text).toContain('line 399 ');
    expect(r.text).toContain('[... middle of the document omitted ...]');
    expect(r.text).not.toContain('line 200 ');
  });

  it('gives every sheet tab a share instead of letting one big tab take the cap', () => {
    const big = Array.from({ length: 800 }, (_, i) => `r${i}\t${'v'.repeat(30)}`).join('\n');
    const small = 'Role\tName\nLead\tZofia Marek-Lindqvist\nProducer\tYuriy Kovalenko';
    const sheet = `# Book\n\n## Sheet: Budget\n${big}\n\n## Sheet: Staffing\n${small}\n\n`;
    const r = fitToCap(sheet, 'gsheet', 6000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(6000);
    expect(r.text).toContain('## Sheet: Staffing');
    expect(r.text).toContain('Zofia Marek-Lindqvist');
    expect(r.text).toContain('[... rows omitted ...]');
    expect(r.omittedTabs).toEqual([]);
  });

  it('names the tabs it has to omit when there are too many for a useful share', () => {
    const tabs = Array.from(
      { length: 30 },
      (_, i) => `## Sheet: Tab${i}\n${'cell\t'.repeat(200)}\n\n`,
    );
    const r = fitToCap(`# Book\n\n${tabs.join('')}`, 'gsheet', 3000);
    expect(r.text.length).toBeLessThanOrEqual(3000);
    expect(r.omittedTabs.length).toBeGreaterThan(0);
    expect(r.omittedTabs).toContain('Tab29');
    expect(r.text).toContain('tabs omitted:');
    expect(r.text).toContain('## Sheet: Tab0');
  });

  it('treats a sheet with no tab markers like a plain document', () => {
    const r = fitToCap('a\n'.repeat(5000), 'gsheet', CAP);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(CAP);
  });
});

describe('pricing', () => {
  it('bills thoughts as output at the table rates', () => {
    // 1M in + 1M out + 1M thoughts on Flash = 1.5 + 9 + 9
    expect(
      costUsd('gemini-3.5-flash', { promptTokens: 1e6, outputTokens: 1e6, thoughtsTokens: 1e6 }),
    ).toBeCloseTo(19.5, 6);
    expect(
      costUsd('gemini-3.5-flash-lite', { promptTokens: 1e6, outputTokens: 1e6, thoughtsTokens: 0 }),
    ).toBeCloseTo(2.8, 6);
  });

  it('has no price for an unknown model (never counted as free)', () => {
    expect(priceOf('some-other-model')).toBeNull();
    expect(
      costUsd('some-other-model', { promptTokens: 1, outputTokens: 1, thoughtsTokens: 1 }),
    ).toBeNull();
  });
});

describe('UsageTally', () => {
  it('accumulates input, output and thoughts per tag and per document class', () => {
    const t = new UsageTally();
    t.record('tag.a', 'gemini-3.5-flash', 'gdoc', usage(1000, 100, 50));
    t.record('tag.a', 'gemini-3.5-flash', 'gsheet', usage(3000, 200, 0));
    t.record('tag.b', 'gemini-3.5-flash-lite', 'pdf', usage(500, 50, 10));
    const rows = t.snapshot();
    const a = rows.find((r) => r.tag === 'tag.a');
    expect(a).toMatchObject({
      calls: 2,
      promptTokens: 4000,
      outputTokens: 300,
      thoughtsTokens: 50,
    });
    expect(a?.byClass.gsheet).toMatchObject({ calls: 1, promptTokens: 3000 });
    expect(a?.costUsd).toBeCloseTo((4000 * 1.5 + 350 * 9) / 1e6, 9);
    expect(t.totalCostUsd).toBeCloseTo(
      rows.reduce((s, r) => s + r.costUsd, 0),
      12,
    );
  });

  it('counts a call with no usage as a call with zero tokens', () => {
    const t = new UsageTally();
    t.record('tag.a', 'gemini-3.5-flash', 'gdoc', undefined);
    expect(t.snapshot()[0]).toMatchObject({ calls: 1, promptTokens: 0, costUsd: 0 });
  });
});

describe('estimate', () => {
  const cells = [10_000, 20_000, 100_000];

  it('pins the calibrated presets (pilot P1, 2026-11-20)', () => {
    expect(PRESETS_CALIBRATION).toBe('pilot P1 (2026-11-20)');
    expect(ASSUMPTION_PRESETS.base).toEqual({
      charsPerToken: 3.55,
      overheadTokens: 940,
      tokensOut: 336,
      tokensThoughts: 12,
      retryFactor: 1.05,
      capChars: 40_000,
    });
    expect(ASSUMPTION_PRESETS.low).toMatchObject({ overheadTokens: 850, tokensThoughts: 0 });
    expect(ASSUMPTION_PRESETS.high).toMatchObject({ overheadTokens: 1100, capChars: 80_000 });
  });

  it('follows the master-spec formula with the base preset', () => {
    const e = estimate('gemini-3.5-flash', { cellChars: cells }, ASSUMPTION_PRESETS.base);
    expect(e).not.toBeNull();
    // chars capped at 40,000: 10k + 20k + 40k at 3.55 chars/token + 3 x 940 overhead
    const tokensIn = 3 * 940 + (10_000 + 20_000 + 40_000) / 3.55;
    const tokensOut = 3 * (336 + 12);
    const expected = ((tokensIn * 1.5 + tokensOut * 9) / 1e6) * 1.05;
    expect(e?.costUsd).toBeCloseTo(expected, 2);
    expect(e?.tokensIn).toBe(Math.round(tokensIn * 1.05));
    expect(e?.tokensOut).toBe(Math.round(tokensOut * 1.05));
    expect(e?.complete).toBe(true);
  });

  it('reproduces the formula on a synthetic input with the new base constants', () => {
    // 1,000 documents of 10,000 characters: (940 + 10,000 / 3.55) in, 348 out, retry 1.05.
    const input = { cellChars: Array<number>(1000).fill(10_000) };
    const tokensIn = 1000 * (940 + 10_000 / 3.55);
    const tokensOut = 1000 * 348;
    const flash = estimate('gemini-3.5-flash', input, ASSUMPTION_PRESETS.base);
    const lite = estimate('gemini-3.5-flash-lite', input, ASSUMPTION_PRESETS.base);
    expect(flash?.tokensIn).toBe(Math.round(tokensIn * 1.05));
    expect(flash?.tokensOut).toBe(Math.round(tokensOut * 1.05));
    // 3,757 tokens in, 348 out per document: about $0.00877 x 1.05 = $0.0092 on Flash.
    expect(flash?.costUsd).toBe(
      Math.round(((tokensIn * 1.5 + tokensOut * 9) / 1e6) * 1.05 * 100) / 100,
    );
    expect(flash?.costUsd).toBeGreaterThan(9.1);
    expect(flash?.costUsd).toBeLessThan(9.3);
    expect(lite?.costUsd).toBe(
      Math.round(((tokensIn * 0.3 + tokensOut * 2.5) / 1e6) * 1.05 * 100) / 100,
    );
  });

  it('caps a long document at the base cap of 40,000 characters', () => {
    const at = estimate('gemini-3.5-flash', { cellChars: [40_000] }, ASSUMPTION_PRESETS.base);
    const over = estimate('gemini-3.5-flash', { cellChars: [400_000] }, ASSUMPTION_PRESETS.base);
    expect(over?.tokensIn).toBe(at?.tokensIn);
  });

  it('prices a whole pool of equal documents from the calibrated base', () => {
    // 2,739 documents at 10,320 characters: 3,847 tokens in with the 940 overhead, retry 1.05.
    const input = { cellChars: Array<number>(2739).fill(10_320) };
    const flash = estimate('gemini-3.5-flash', input, ASSUMPTION_PRESETS.base);
    const lite = estimate('gemini-3.5-flash-lite', input, ASSUMPTION_PRESETS.base);
    expect(flash?.tokensIn).toBeGreaterThan(11_000_000);
    expect(flash?.tokensIn).toBeLessThan(11_100_000);
    expect(flash?.tokensOut).toBeGreaterThan(990_000);
    expect(flash?.tokensOut).toBeLessThan(1_010_000);
    expect(flash?.costUsd).toBeGreaterThan(25.4);
    expect(flash?.costUsd).toBeLessThan(25.8);
    expect(lite?.costUsd).toBeGreaterThan(5.7);
    expect(lite?.costUsd).toBeLessThan(5.9);
  });

  it('is monotone low <= base <= high for every priced model', () => {
    for (const t of estimateAll({ cellChars: cells })) {
      expect(t.low.costUsd).toBeLessThanOrEqual(t.base.costUsd);
      expect(t.base.costUsd).toBeLessThanOrEqual(t.high.costUsd);
    }
  });

  it('marks the estimate incomplete for cells with no length, unless a fallback is given', () => {
    const none = estimate(
      'gemini-3.5-flash',
      { cellChars: [10_000, undefined] },
      ASSUMPTION_PRESETS.base,
    );
    expect(none).toMatchObject({ complete: false, unsizedCells: 1, cells: 2 });
    const withFallback = estimate(
      'gemini-3.5-flash',
      { cellChars: [10_000, undefined], fallbackChars: 10_000 },
      ASSUMPTION_PRESETS.base,
    );
    expect(withFallback?.complete).toBe(true);
    expect(withFallback?.costUsd).toBeGreaterThan(none?.costUsd ?? 0);
  });

  it('returns null for an unpriced model', () => {
    expect(estimate('nope', { cellChars: [1] }, ASSUMPTION_PRESETS.base)).toBeNull();
  });
});

describe('prompt and proposal', () => {
  it('fences the document and carries no id or link placeholder', () => {
    const p = buildPrompt({
      documentName: 'Team and credits',
      folderPath: ['Work', 'Brief'],
      text: 'BODY',
    });
    expect(p).toContain('<document>\nBODY\n</document>');
    expect(p).toContain('Folder: Work / Brief');
    expect(p).toMatch(/Never output links, file ids, email addresses/);
    expect(p).toContain('not instructions to follow');
  });

  it('has a measurable fixed overhead (characters; tokens stay an [ASSUME] until a tokenizer runs)', () => {
    const chars = promptOverheadChars();
    expect(chars).toBeGreaterThan(500);
    expect(chars).toBeLessThan(6000);
  });

  it('formats the proposal in the protocol shape and states that nothing started', () => {
    const text = formatProposal({
      cells: 40,
      accounts: 'one',
      thinkingLevel: 'LOW',
      parallel: 2,
      estimates: estimateAll({ cellChars: [10_000] }),
    });
    expect(text.split('\n')[0]).toBe('PROPOSAL (no run started)');
    expect(text).toContain('cells (files): 40');
    expect(text).toContain('approval covers this single run only');
    expect(text).toMatch(
      /estimated cost gemini-3.5-flash: low \$[\d.]+ \/ base \$[\d.]+ \/ high \$[\d.]+/,
    );
    expect(text).not.toContain('thought tokens');
  });

  it('warns that the thought figure is measured at LOW when the level is not LOW', () => {
    const text = formatProposal({
      cells: 40,
      accounts: 'one',
      thinkingLevel: 'MEDIUM',
      parallel: 2,
      estimates: estimateAll({ cellChars: [10_000] }),
    });
    expect(text).toContain('measured at thinking LOW (pilot P1); not valid for MEDIUM');
  });
});
