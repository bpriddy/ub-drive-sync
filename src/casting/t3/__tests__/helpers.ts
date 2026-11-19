/**
 * Test doubles and synthetic fixtures for the T3 stage. Every name, folder and
 * id below is invented. No test in this directory reaches a model, Drive or a
 * database: the model is FakeLlm, the reader is FakeReader.
 */
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmDriver,
  LlmUsage,
} from '../../../ai/ai.types';
import type { DocumentReader, ReadOutcome, T3Candidate } from '../types';

export const GDOC = 'application/vnd.google-apps.document';
export const GSLIDES = 'application/vnd.google-apps.presentation';
export const GSHEET = 'application/vnd.google-apps.spreadsheet';
export const PDF = 'application/pdf';
export const ACCOUNT = 'acct-0001';

export function cand(over: Partial<T3Candidate> & { fileId: string; name: string }): T3Candidate {
  return {
    mimeType: GDOC,
    ancestors: ['Projects', 'Spring Launch', 'Brief'],
    modifiedTime: '2025-03-10T09:00:00.000Z',
    createdTime: '2025-01-15T09:00:00.000Z',
    accountId: ACCOUNT,
    ...over,
  };
}

export const usage = (p = 1000, o = 100, t = 50): LlmUsage => ({
  promptTokens: p,
  outputTokens: o,
  thoughtsTokens: t,
  totalTokens: p + o + t,
  cachedContentTokens: 0,
});

export interface Item {
  raw_name: string;
  raw_role: string | null;
  quote: string;
  is_client_side?: boolean;
  period_text?: string | null;
}

export function answer(
  docType: string,
  items: Item[],
  u: LlmUsage | undefined = usage(),
): LlmCompletionResult {
  return {
    text: JSON.stringify({
      doc_type: docType,
      mentions: items.map((i) => ({
        is_client_side: false,
        period_text: null,
        ...i,
      })),
    }),
    driver: 'fake',
    model: 'fake',
    ...(u ? { usage: u } : {}),
    finishReason: 'STOP',
  };
}

/** A canned-JSON model. Tracks calls and the peak number of calls in flight. */
export class FakeLlm implements LlmDriver {
  readonly name = 'fake';
  readonly calls: LlmCompletionRequest[] = [];
  peak = 0;
  private inFlight = 0;

  constructor(
    private readonly handler: (
      req: LlmCompletionRequest,
      n: number,
    ) => LlmCompletionResult | Promise<LlmCompletionResult>,
    private readonly delayMs = 0,
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.calls.push(req);
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      return await this.handler(req, this.calls.length);
    } finally {
      this.inFlight--;
    }
  }
}

export class FakeReader implements DocumentReader {
  readonly reads: string[] = [];
  constructor(private readonly texts: Record<string, string | ReadOutcome | Error>) {}

  async read(c: T3Candidate): Promise<ReadOutcome> {
    this.reads.push(c.fileId);
    const t = this.texts[c.fileId];
    if (t === undefined) return { kind: 'skip', reason: 'empty' };
    if (t instanceof Error) throw t;
    return typeof t === 'string' ? { kind: 'ok', text: t } : t;
  }
}

/** A short credits deck: names with diacritics, a nickname, a transliteration shape. */
export const CREDITS_DECK = [
  '# Spring Launch Credits',
  '',
  '## Slide 1',
  'Spring Launch: team and credits',
  '',
  '## Slide 2',
  'Creative Director: Jürgen Falkenrath',
  'Senior Copywriter: Zofia Marek-Lindqvist',
  'Art Director: Łukasz Wieczorkiewicz',
  'Producer: Yuriy Kovalenko',
  'Client lead: Pavel Orlovsky (VP Marketing, Northwind Foods)',
  '',
  '## Slide 3',
  'Thanks to everyone, especially Sam for the late nights.',
].join('\n');
