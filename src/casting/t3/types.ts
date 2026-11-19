/**
 * Shared types of the T3 stage (document content mentions).
 *
 * Nothing in this file imports config, prisma, Drive or a model client: the
 * stage core stays hermetic, and the real wiring (real-llm.ts, real-reader.ts)
 * is the only place that can reach them, lazily.
 */

/** Tag recorded on every model call of this stage (usage accounting, thinking map). */
export const T3_CALL_TAG = 'casting.t3_mentions.v1';

/** Bump when the prompt or the response schema changes: it re-keys every cell. */
export const T3_PROMPT_VERSION = 'v1';

/** Layer 1 `source` value written by this stage. */
export const T3_SOURCE = 'drive_content' as const;

/** The only parallelism this stage allows (README rule 9: 429s on reads and on the model). */
export const T3_MAX_PARALLEL = 2;

/** Document classes the triage and the truncation distinguish. */
export const DOC_CLASSES = ['gdoc', 'gslides', 'gsheet', 'pdf', 'docx', 'pptx', 'text'] as const;
export type DocClass = (typeof DOC_CLASSES)[number];

/**
 * One file as the shortlist step sees it: metadata only, no content. The
 * caller (S4's shortlist, or a listing export) builds these. Ids stay on this
 * side of the model boundary: they are never put in a prompt.
 */
export interface T3Candidate {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  /** Folder names from the drive root down to the parent folder. */
  readonly ancestors: readonly string[];
  readonly modifiedTime: string | null;
  readonly createdTime: string | null;
  readonly accountId: string;
  /** Drive md5Checksum: present for blob files only; used to dedupe before any read. */
  readonly md5Checksum?: string | null | undefined;
  /** Drive `capabilities.canDownload`; false = binary read would fail (403). */
  readonly canDownload?: boolean | undefined;
  /** Approximate extracted length, when the listing step measured it (dry-run estimates). */
  readonly approxChars?: number | undefined;
  /** Project reference known from T1 (folder job code); passed through to rows untouched. */
  readonly projectRef?:
    | {
        readonly jobNumber?: string | null | undefined;
        readonly campaignId?: string | null | undefined;
        readonly pieceId?: string | null | undefined;
      }
    | undefined;
}

export type TriageTier = 'A' | 'B' | 'C' | 'X';

export type ReadOutcome =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'skip'; readonly reason: string };

/** Reads and extracts the text of one candidate. The real one is a Drive read. */
export interface DocumentReader {
  read(candidate: T3Candidate): Promise<ReadOutcome>;
}
