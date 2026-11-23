/**
 * The model's response contract for T3, and what code does with it.
 *
 * The response is a FLAT object schema: a discriminated-union Zod schema does
 * not convert to a genai response Schema, so the model gets the flat shape and
 * code validates and transforms afterwards.
 *
 * The model never writes ids, URLs or file references. It returns names, raw
 * role strings, a short verbatim quote and an optional period text. Ids, file
 * refs and project refs are attached by code from the document being processed.
 *
 * Imports `Type` from the vendor package directly on purpose: `src/ai/index.ts`
 * re-exports it, but importing that index constructs the real model driver as a
 * side effect, which this stage must never do outside real-llm.ts.
 */
import { Type, type Schema } from '@google/genai';
import { z } from 'zod';
import { EVIDENCE_QUOTE_MAX_CHARS, cleanText } from './row';

export const DOC_TYPES = [
  'credits_or_team',
  'status_or_timing',
  'brief_or_kickoff',
  'pitch_or_proposal',
  'case_study_or_awards',
  'org_or_directory',
  'meeting_or_recap',
  'contacts_or_distribution',
  'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Hard cap on mentions kept from one document; the excess is counted, not stored. */
export const MAX_MENTIONS_PER_DOC = 200;
export const MAX_NAME_CHARS = 120;
export const MAX_ROLE_CHARS = 100;
export const MAX_PERIOD_CHARS = 60;

export function mentionsResponseSchema(): Schema {
  return {
    type: Type.OBJECT,
    properties: {
      doc_type: {
        type: Type.STRING,
        format: 'enum',
        enum: [...DOC_TYPES],
        description:
          'What kind of document this is. pitch_or_proposal = a team proposed to win work. contacts_or_distribution = address lists, cc lines, contact sheets. When unsure use other.',
      },
      mentions: {
        type: Type.ARRAY,
        description:
          'One entry per person the document explicitly ties to the work. Empty array when it names nobody with a role or team membership.',
        items: {
          type: Type.OBJECT,
          properties: {
            raw_name: {
              type: Type.STRING,
              description: 'The person name exactly as written in the document.',
            },
            raw_role: {
              type: Type.STRING,
              nullable: true,
              description: 'The role or title exactly as written next to the name; null if none.',
            },
            quote: {
              type: Type.STRING,
              description: `A verbatim excerpt of at most ${EVIDENCE_QUOTE_MAX_CHARS} characters that contains the name and, if present, the role.`,
            },
            is_client_side: {
              type: Type.BOOLEAN,
              description:
                'True when the person works for the client or another outside company, not for the agency that wrote the document.',
            },
            period_text: {
              type: Type.STRING,
              nullable: true,
              description:
                'When the work took place, exactly as written (a year, a month, a range); null if the document gives none.',
            },
          },
          required: ['raw_name', 'raw_role', 'quote', 'is_client_side', 'period_text'],
        },
      },
    },
    required: ['doc_type', 'mentions'],
  };
}

const itemSchema = z.object({
  raw_name: z.string(),
  raw_role: z.string().nullable(),
  quote: z.string(),
  is_client_side: z.boolean(),
  period_text: z.string().nullable(),
});

const envelopeSchema = z.object({
  doc_type: z.string(),
  mentions: z.array(z.unknown()),
});

/** A mention after validation and sanitising, still raw text. No ids, no URLs. */
export interface RawMention {
  readonly rawName: string;
  readonly rawRole: string | null;
  readonly quote: string | null;
  readonly isClientSide: boolean;
  readonly periodText: string | null;
}

export interface SanitizeStats {
  itemsSeen: number;
  itemsInvalid: number;
  droppedUrlOrId: number;
  droppedBadName: number;
  quoteTruncated: number;
  quoteLinkRedacted: number;
  mentionsCapped: number;
  docTypeCoerced: boolean;
}

export type ParsedResponse =
  | {
      readonly ok: true;
      readonly docType: DocType;
      readonly mentions: RawMention[];
      readonly stats: SanitizeStats;
    }
  | { readonly ok: false; readonly error: string };

const URL_LIKE =
  /(https?:\/\/|\bwww\.|\b(?:docs|drive|sheets|slides)\.google\.com|\b[a-z0-9-]+\.(?:com|org|net|io|co|app)\/)/i;
const UUID_LIKE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
/** A Drive-id-looking token: one long unbroken run of id characters. */
const OPAQUE_TOKEN = /[A-Za-z0-9_-]{25,}/;

const squash = (s: string): string => cleanText(s);

function looksLikeUrlOrId(s: string): boolean {
  return URL_LIKE.test(s) || UUID_LIKE.test(s) || OPAQUE_TOKEN.test(s);
}

/** Strict parse of the model text, then a lenient per-item sanitise. */
export function parseMentionsResponse(text: string): ParsedResponse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not_json' };
  }
  const env = envelopeSchema.safeParse(value);
  if (!env.success) return { ok: false, error: 'bad_envelope' };

  const stats: SanitizeStats = {
    itemsSeen: env.data.mentions.length,
    itemsInvalid: 0,
    droppedUrlOrId: 0,
    droppedBadName: 0,
    quoteTruncated: 0,
    quoteLinkRedacted: 0,
    mentionsCapped: 0,
    docTypeCoerced: false,
  };
  let docType: DocType;
  if ((DOC_TYPES as readonly string[]).includes(env.data.doc_type)) {
    docType = env.data.doc_type as DocType;
  } else {
    docType = 'other';
    stats.docTypeCoerced = true;
  }

  const mentions: RawMention[] = [];
  for (const entry of env.data.mentions) {
    const item = itemSchema.safeParse(entry);
    if (!item.success) {
      stats.itemsInvalid++;
      continue;
    }
    const rawName = squash(item.data.raw_name);
    const rawRole = item.data.raw_role === null ? null : squash(item.data.raw_role);
    if (rawName.length === 0 || rawName.length > MAX_NAME_CHARS || !/\p{L}/u.test(rawName)) {
      stats.droppedBadName++;
      continue;
    }
    if (looksLikeUrlOrId(rawName) || (rawRole !== null && looksLikeUrlOrId(rawRole))) {
      stats.droppedUrlOrId++;
      continue;
    }
    if (mentions.length >= MAX_MENTIONS_PER_DOC) {
      stats.mentionsCapped++;
      continue;
    }
    let quote: string | null = squash(item.data.quote);
    if (URL_LIKE.test(quote)) {
      quote = quote.replace(new RegExp(URL_LIKE.source + '\\S*', 'gi'), '[link]');
      stats.quoteLinkRedacted++;
    }
    // Counted here, cut in groundMentions: a quote cut before grounding loses its
    // last word mid-way and no longer matches the text it came from.
    if (quote.length > EVIDENCE_QUOTE_MAX_CHARS) stats.quoteTruncated++;
    if (quote.length === 0) quote = null;
    const period = item.data.period_text === null ? null : squash(item.data.period_text);
    mentions.push({
      rawName,
      rawRole: rawRole === null || rawRole.length === 0 ? null : rawRole.slice(0, MAX_ROLE_CHARS),
      quote,
      isClientSide: item.data.is_client_side,
      periodText:
        period === null || period.length === 0 || period.length > MAX_PERIOD_CHARS ? null : period,
    });
  }
  return { ok: true, docType, mentions, stats };
}
