import { describe, expect, it } from 'vitest';
import { Type } from '@google/genai';
import {
  DOC_TYPES,
  MAX_MENTIONS_PER_DOC,
  mentionsResponseSchema,
  parseMentionsResponse,
} from '../schema';
import { foldForMatch, groundMentions, locationOf, nameIsGrounded, groundingOf } from '../ground';
import { parsePeriod } from '../period';
import { CREDITS_DECK } from './helpers';

const wrap = (mentions: unknown[], doc_type: unknown = 'credits_or_team'): string =>
  JSON.stringify({ doc_type, mentions });
const item = (over: Record<string, unknown> = {}) => ({
  raw_name: 'Zofia Marek-Lindqvist',
  raw_role: 'Senior Copywriter',
  quote: 'Senior Copywriter: Zofia Marek-Lindqvist',
  is_client_side: false,
  period_text: null,
  ...over,
});

describe('response schema (what the model is given)', () => {
  const schema = mentionsResponseSchema();

  it('is a flat object schema with no id, url or file field anywhere', () => {
    const json = JSON.stringify(schema);
    expect(schema.type).toBe(Type.OBJECT);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['doc_type', 'mentions']);
    const props = (schema.properties?.['mentions']?.items?.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(props).sort()).toEqual([
      'is_client_side',
      'period_text',
      'quote',
      'raw_name',
      'raw_role',
    ]);
    expect(json).not.toMatch(/"(id|url|link|file_id|staff_id|email)"/);
    expect(json).not.toContain('anyOf');
    expect(json).not.toContain('oneOf');
  });

  it('closes doc_type to the enum', () => {
    expect(schema.properties?.['doc_type']?.enum).toEqual([...DOC_TYPES]);
  });
});

describe('parseMentionsResponse', () => {
  it('accepts a valid answer and keeps text fields', () => {
    const r = parseMentionsResponse(wrap([item()]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.docType).toBe('credits_or_team');
      expect(r.mentions[0]).toMatchObject({
        rawName: 'Zofia Marek-Lindqvist',
        rawRole: 'Senior Copywriter',
      });
    }
  });

  it('rejects non-JSON and a broken envelope (those are retried by the runner)', () => {
    expect(parseMentionsResponse('not json')).toEqual({ ok: false, error: 'not_json' });
    expect(parseMentionsResponse(JSON.stringify({ doc_type: 'other' }))).toEqual({
      ok: false,
      error: 'bad_envelope',
    });
    expect(parseMentionsResponse(JSON.stringify([]))).toEqual({ ok: false, error: 'bad_envelope' });
  });

  it('drops an invalid item but keeps the rest, and counts it', () => {
    const r = parseMentionsResponse(
      wrap([item(), { raw_name: 5 }, item({ raw_name: 'Jürgen Falkenrath' })]),
    );
    expect(r.ok && r.mentions).toHaveLength(2);
    expect(r.ok && r.stats.itemsInvalid).toBe(1);
  });

  it('coerces an unknown doc_type to other instead of failing the document', () => {
    const r = parseMentionsResponse(wrap([item()], 'brand_new_type'));
    expect(r.ok && r.docType).toBe('other');
    expect(r.ok && r.stats.docTypeCoerced).toBe(true);
  });

  it('drops a mention whose name or role carries a URL or an id', () => {
    const r = parseMentionsResponse(
      wrap([
        item({ raw_name: 'https://example.test/jane' }),
        item({ raw_name: 'Jane Roe', raw_role: 'see docs.google.com/document/d/abc' }),
        item({ raw_name: '1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' }),
        item({ raw_name: '123e4567-e89b-12d3-a456-426614174000' }),
        item({ raw_name: 'Alexander Voronin' }),
      ]),
    );
    expect(r.ok && r.mentions.map((m) => m.rawName)).toEqual(['Alexander Voronin']);
    expect(r.ok && r.stats.droppedUrlOrId).toBe(4);
  });

  it('redacts a link inside a quote and caps the quote at 300 characters', () => {
    const r = parseMentionsResponse(
      wrap([
        item({ quote: 'Producer Jane Roe, see https://example.test/x?y=1 for more' }),
        item({ raw_name: 'Alexander Voronin', quote: 'x'.repeat(500) }),
      ]),
    );
    expect(r.ok && r.mentions[0]?.quote).toBe('Producer Jane Roe, see [link] for more');
    expect(r.ok && r.mentions[1]?.quote).toHaveLength(300);
    expect(r.ok && r.stats.quoteLinkRedacted).toBe(1);
    expect(r.ok && r.stats.quoteTruncated).toBe(1);
  });

  it('caps mentions per document and counts the excess', () => {
    const many = Array.from({ length: MAX_MENTIONS_PER_DOC + 5 }, (_, i) =>
      item({ raw_name: `Person Number${String.fromCharCode(97 + (i % 26))}${'z'.repeat(i % 7)}` }),
    );
    const r = parseMentionsResponse(wrap(many));
    expect(r.ok && r.mentions).toHaveLength(MAX_MENTIONS_PER_DOC);
    expect(r.ok && r.stats.mentionsCapped).toBe(5);
  });

  it('normalises whitespace and nulls an empty role', () => {
    const r = parseMentionsResponse(
      wrap([item({ raw_name: '  Jürgen \n Falkenrath ', raw_role: '  ' })]),
    );
    expect(r.ok && r.mentions[0]).toMatchObject({ rawName: 'Jürgen Falkenrath', rawRole: null });
  });
});

describe('grounding', () => {
  it('folds diacritics, case and punctuation', () => {
    expect(foldForMatch('Łukasz  Wieczorkiewicz,')).toBe('lukasz wieczorkiewicz');
    expect(foldForMatch('José Álvarez-Quintero')).toBe('jose alvarez quintero');
  });

  it('finds a name written as in the text, with or without diacritics, and "Last, First" order', () => {
    const g = groundingOf(CREDITS_DECK);
    expect(nameIsGrounded(g, 'Jurgen Falkenrath')).toBe(true);
    expect(nameIsGrounded(g, 'Falkenrath, Jürgen')).toBe(true);
    expect(nameIsGrounded(g, 'Zofia Marek-Lindqvist')).toBe(true);
    expect(nameIsGrounded(g, 'Taylor Brennan')).toBe(false);
  });

  it('drops an invented name, drops an invented quote but keeps the mention, and adds a location', () => {
    const base = {
      rawRole: 'Producer',
      isClientSide: false,
      periodText: null,
    };
    const out = groundMentions(CREDITS_DECK, [
      { ...base, rawName: 'Yuriy Kovalenko', quote: 'Producer: Yuriy Kovalenko' },
      { ...base, rawName: 'Taylor Brennan', quote: 'Producer: Taylor Brennan' },
      { ...base, rawName: 'Jürgen Falkenrath', quote: 'He led the whole thing with great flair' },
    ]);
    expect(out.mentions.map((m) => m.rawName)).toEqual(['Yuriy Kovalenko', 'Jürgen Falkenrath']);
    expect(out.mentions[0]?.location).toBe('slide 2');
    expect(out.mentions[1]?.quote).toBeNull();
    expect(out.mentions[1]?.location).toBeNull();
    expect(out.stats).toEqual({ droppedUngroundedName: 1, quoteDroppedUngrounded: 1 });
  });

  it('locates a sheet tab and ignores documents without markers', () => {
    const sheet =
      '# Book\n\n## Sheet: Budget\nrow\n\n## Sheet: Staffing\nLead\tZofia Marek-Lindqvist\n';
    expect(locationOf(sheet, 'Lead Zofia Marek-Lindqvist')).toBe('sheet: Staffing');
    expect(locationOf('plain text with Jane Roe', 'Jane Roe')).toBeNull();
    expect(locationOf(sheet, null)).toBeNull();
  });
});

describe('parsePeriod', () => {
  const now = new Date('2026-11-19T00:00:00Z');
  const p = (s: string | null) => parsePeriod(s, now);

  it('reads years, months, dates and quarters', () => {
    expect(p('2023')).toEqual({ start: '2023-01-01', end: '2023-12-31' });
    expect(p('2023-05')).toEqual({ start: '2023-05-01', end: '2023-05-31' });
    expect(p('2024-02-10')).toEqual({ start: '2024-02-10', end: '2024-02-10' });
    expect(p('May 2023')).toEqual({ start: '2023-05-01', end: '2023-05-31' });
    expect(p('Q3 2023')).toEqual({ start: '2023-07-01', end: '2023-09-30' });
    expect(p('Feb 2024')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
  });

  it('reads ranges', () => {
    expect(p('May 2023 - Aug 2023')).toEqual({ start: '2023-05-01', end: '2023-08-31' });
    expect(p('2023-2024')).toEqual({ start: '2023-01-01', end: '2024-12-31' });
    expect(p('Jan 2023 to Mar 2023')).toEqual({ start: '2023-01-01', end: '2023-03-31' });
    expect(p('Sept 2022–Dec 2022')).toEqual({ start: '2022-09-01', end: '2022-12-31' });
  });

  it('returns nothing for anything it cannot read, and for implausible years or reversed ranges', () => {
    for (const s of [
      'sometime last spring',
      '12/31',
      '1885',
      '2099',
      'Aug 2023 - May 2023',
      '2023-13',
      null,
    ]) {
      expect(p(s)).toEqual({ start: null, end: null });
    }
  });
});
