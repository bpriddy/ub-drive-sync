/**
 * Deterministic triage: which files are worth sending to the model.
 *
 * A port of the S1 ruleset (tiers A, B, C, X) as pure functions of
 * {name, parent folder, mime}. Rules never look at file content. The base
 * point of the cost curve is tiers A + B; `tight` (A only) and `recall_max`
 * (A + B + C) exist for the cost / recall trade-off the owner decides.
 *
 * Tier X is hard noise (invoices, web build output, camera sidecars) and is
 * never sent. Ad scripts and signed agreements are soft noise: kept out of A
 * and B, left in C. Sheets and plain text are only A (explicit keyword) or C.
 * Names are English-only; a non-English document falls into B or C.
 */
import type { DocClass, T3Candidate, TriageTier } from './types';

const STRONG =
  /\b(credits?|team|staffing|staff|resourc(?:e|es|ing)|roster|org(?:ani[sz]ation)?[ _-]?chart|who'?s who|kick[ _-]?off|sow|sows|statement of work|scope of work|brief\w*|re-?brief|status(?: doc| report| update| sheet| tracker)?|hot ?sheet|timing|timeline|schedule|calendar|pre[ _-]?pro(?:duction)?|ppm|prepro|call ?sheet|production (?:recap|book|report|schedule)|post[ _-]?mortem|wrap(?: report)?|debrief|hand[ _-]?over|onboarding|contacts?|stakeholders?|raci|case stud(?:y|ies)|awards?|effie|cannes|pitch|proposal|capabilit(?:y|ies)|credentials|leadership|agency)\b/i;
const MODERATE_NAME =
  /(recap|review|report|notes|deck|overview|summary|plan|tracker|estimate|bid|budget|treatment|presentation|guidelines|framework|strategy|narrative|insight|master|meeting|agenda|minutes|retro|learnings|handbook|training|playbook)/i;
const MODERATE_FOLDER =
  /(internal decks?|client presentations?|external decks?|client decks?|meeting notes|strategy|research|account|creative development|brand|presentations?|decks?|production recap|onboarding|handbook)/i;
const HARD_NOISE =
  /(invoice|overdue|receipt|\bw-?9\b|webpack|polyfills|buildmanifest|ssgmanifest|_next|\.js$|\.map$|\.css$|\.json$|\.html?$|\.ts$|\.xml$|\.xmp$|thumbs\.db|\.ds_store)/i;
const SOFT_NOISE = /\bscripts?\b/i;
const SIGNED = /\b(nda|signed|executed|agreement|release|w-?9)\b/i;
const SKIP_MIME = /^text\/(javascript|css|html|x-|xml)/;

const MIME_CLASS: Readonly<Record<string, DocClass>> = {
  'application/vnd.google-apps.document': 'gdoc',
  'application/vnd.google-apps.presentation': 'gslides',
  'application/vnd.google-apps.spreadsheet': 'gsheet',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const NATIVE_CLASSES: ReadonlySet<DocClass> = new Set(['gdoc', 'gslides', 'gsheet']);

/** The document class of a mime type, or null when the extractor cannot read it. */
export function docClassOf(mimeType: string): DocClass | null {
  const known = MIME_CLASS[mimeType];
  if (known) return known;
  return mimeType.startsWith('text/') ? 'text' : null;
}

export const isNativeClass = (cls: DocClass): boolean => NATIVE_CLASSES.has(cls);

export interface TriageInput {
  readonly name: string;
  readonly parentFolder: string;
  readonly mimeType: string;
  readonly docClass: DocClass;
}

export interface TriageResult {
  readonly tier: TriageTier;
  readonly why:
    | 'hard_noise'
    | 'kw_name_or_folder'
    | 'kw_name'
    | 'kw_folder'
    | 'scripts'
    | 'signed_agreements'
    | 'deck'
    | 'moderate_kw'
    | 'other';
}

export function triage(x: TriageInput): TriageResult {
  const { name, parentFolder: folder } = x;
  if (SKIP_MIME.test(x.mimeType) || HARD_NOISE.test(name) || HARD_NOISE.test(folder)) {
    return { tier: 'X', why: 'hard_noise' };
  }
  if (x.docClass === 'gsheet' || x.docClass === 'text') {
    if (STRONG.test(name) || STRONG.test(folder)) return { tier: 'A', why: 'kw_name_or_folder' };
    return { tier: 'C', why: 'other' };
  }
  const soft = SOFT_NOISE.test(name) || SOFT_NOISE.test(folder);
  const signed = SIGNED.test(name) || SIGNED.test(folder);
  if (STRONG.test(name)) return { tier: 'A', why: 'kw_name' };
  if (STRONG.test(folder) && !soft) return { tier: 'A', why: 'kw_folder' };
  if (soft) return { tier: 'C', why: 'scripts' };
  if (signed) return { tier: 'C', why: 'signed_agreements' };
  if (x.docClass === 'gslides' || x.docClass === 'pptx') return { tier: 'B', why: 'deck' };
  if (MODERATE_NAME.test(name) || MODERATE_FOLDER.test(folder)) {
    return { tier: 'B', why: 'moderate_kw' };
  }
  return { tier: 'C', why: 'other' };
}

/**
 * Name family key for the version collapse: strips extension, "v2", "final",
 * "copy of", "(1)", short dates; keeps the folder path so two projects'
 * identically named files are never merged.
 */
export function versionFamilyKey(c: Pick<T3Candidate, 'name' | 'ancestors'>): string {
  const stem = c.name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/\b(v|ver|version)\s*\d+(\.\d+)?\b/g, '')
    .replace(/\b(final|copy of|copy|wip|updated|draft|rev(ised)?)\s*\d*\b/g, '')
    .replace(/\(\d+\)/g, '')
    .replace(/\b\d{1,2}[-_/.]\d{1,2}([-_/.]\d{2,4})?\b/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  return `${c.ancestors.join('/')}|${stem}`;
}

export const TRIAGE_VARIANTS = ['tight', 'base', 'recall_max'] as const;
export type TriageVariant = (typeof TRIAGE_VARIANTS)[number];

const VARIANT_TIERS: Readonly<Record<TriageVariant, ReadonlySet<TriageTier>>> = {
  tight: new Set<TriageTier>(['A']),
  base: new Set<TriageTier>(['A', 'B']),
  recall_max: new Set<TriageTier>(['A', 'B', 'C']),
};

export interface SelectionPolicy {
  /** Default `base` (tiers A + B), the accepted base point. */
  readonly variant?: TriageVariant | undefined;
  /** Files modified before this ISO day are out (the sliding 5-year window). Recorded in the run. */
  readonly windowStart: string;
  /**
   * Drives whose binary files cannot be read (403): only Google-native
   * documents are selected for these accounts; binaries count as skipped by
   * rule, not as failures.
   */
  readonly nativeOnlyAccountIds?: ReadonlySet<string> | undefined;
  /**
   * Modified dates that are an import artifact (the epoch placeholder
   * 1980-01-01) say nothing about the window: such files are excluded.
   */
  readonly excludeEpochDates?: boolean | undefined;
  /** Collapse same-md5 files and version families before any read. Default true. */
  readonly collapseDuplicates?: boolean | undefined;
}

export const EXCLUSION_REASONS = [
  'no_modified_time',
  'outside_window',
  'epoch_date',
  'unsupported_mime',
  'native_only_binary',
  'cannot_download',
  'hard_noise',
  'below_variant',
  'duplicate_md5',
  'duplicate_version_family',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface SelectedCandidate {
  readonly candidate: T3Candidate;
  readonly docClass: DocClass;
  readonly tier: Exclude<TriageTier, 'X'>;
  readonly why: TriageResult['why'];
}

export interface Selection {
  readonly selected: readonly SelectedCandidate[];
  readonly excluded: Readonly<Record<ExclusionReason, number>>;
  /** Files dropped as duplicates: dropped id -> kept id (audit; never sent, never a row). */
  readonly duplicateOf: ReadonlyMap<string, string>;
  /**
   * Identical-content copies (same md5, different file) of each KEPT file, by
   * kept file id. They are never sent to the model; the stage binds the kept
   * file's mentions to each of them (see copies.ts). Version families are NOT
   * here: a different-content older version is only dropped.
   */
  readonly copiesOf: ReadonlyMap<string, readonly SelectedCandidate[]>;
  readonly tierCounts: Readonly<Record<Exclude<TriageTier, 'X'>, number>>;
}

const EPOCH_PREFIX = '1980-01-01';
const TIER_ORDER: Readonly<Record<string, number>> = { A: 0, B: 1, C: 2 };

/** Newest first; ties broken by file id so the pick is stable across runs. */
function prefer(a: SelectedCandidate, b: SelectedCandidate): SelectedCandidate {
  const ta = a.candidate.modifiedTime ?? '';
  const tb = b.candidate.modifiedTime ?? '';
  if (ta !== tb) return ta > tb ? a : b;
  return a.candidate.fileId <= b.candidate.fileId ? a : b;
}

export function selectCandidates(
  candidates: readonly T3Candidate[],
  policy: SelectionPolicy,
): Selection {
  const tiers = VARIANT_TIERS[policy.variant ?? 'base'];
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as Record<
    ExclusionReason,
    number
  >;
  const tierCounts = { A: 0, B: 0, C: 0 };
  const passed: SelectedCandidate[] = [];

  for (const c of candidates) {
    const cls = docClassOf(c.mimeType);
    if (cls === null) {
      excluded.unsupported_mime++;
      continue;
    }
    if (!c.modifiedTime) {
      excluded.no_modified_time++;
      continue;
    }
    if (policy.excludeEpochDates !== false && c.modifiedTime.startsWith(EPOCH_PREFIX)) {
      excluded.epoch_date++;
      continue;
    }
    if (c.modifiedTime.slice(0, 10) < policy.windowStart) {
      excluded.outside_window++;
      continue;
    }
    if (!isNativeClass(cls)) {
      if (policy.nativeOnlyAccountIds?.has(c.accountId)) {
        excluded.native_only_binary++;
        continue;
      }
      if (c.canDownload === false) {
        excluded.cannot_download++;
        continue;
      }
    }
    const t = triage({
      name: c.name,
      parentFolder: c.ancestors[c.ancestors.length - 1] ?? '',
      mimeType: c.mimeType,
      docClass: cls,
    });
    if (t.tier === 'X') {
      excluded.hard_noise++;
      continue;
    }
    if (!tiers.has(t.tier)) {
      excluded.below_variant++;
      continue;
    }
    passed.push({ candidate: c, docClass: cls, tier: t.tier, why: t.why });
  }

  const duplicateOf = new Map<string, string>();
  const copiesOf = new Map<string, SelectedCandidate[]>();
  let kept = passed;
  if (policy.collapseDuplicates !== false) {
    // Version families first (same folder, different content, newest wins), then
    // identical-content copies among the survivors: a copy in another folder is a
    // different project's file and is kept as a copy to expand, never lost.
    kept = collapse(passed, (s) => versionFamilyKey(s.candidate), {
      reason: 'duplicate_version_family',
      excluded,
      duplicateOf,
    });
    kept = collapse(kept, (s) => (s.candidate.md5Checksum ? `${s.candidate.md5Checksum}` : null), {
      reason: 'duplicate_md5',
      excluded,
      duplicateOf,
      copiesOf,
    });
  }

  // A file dropped in the family pass may point at one the md5 pass dropped later.
  for (const [dropped, first] of duplicateOf) {
    let end = first;
    while (duplicateOf.has(end)) end = duplicateOf.get(end) as string;
    duplicateOf.set(dropped, end);
  }

  const selected = [...kept].sort(
    (a, b) =>
      (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) ||
      (a.candidate.fileId < b.candidate.fileId
        ? -1
        : a.candidate.fileId > b.candidate.fileId
          ? 1
          : 0),
  );
  for (const s of selected) tierCounts[s.tier]++;
  return { selected, excluded, duplicateOf, copiesOf, tierCounts };
}

function collapse(
  items: readonly SelectedCandidate[],
  keyOf: (s: SelectedCandidate) => string | null,
  sink: {
    reason: 'duplicate_md5' | 'duplicate_version_family';
    excluded: Record<ExclusionReason, number>;
    duplicateOf: Map<string, string>;
    copiesOf?: Map<string, SelectedCandidate[]>;
  },
): SelectedCandidate[] {
  const winners = new Map<string, SelectedCandidate>();
  for (const s of items) {
    const key = keyOf(s);
    if (key === null) continue;
    const prev = winners.get(key);
    winners.set(key, prev ? prefer(prev, s) : s);
  }
  const out: SelectedCandidate[] = [];
  for (const s of items) {
    const key = keyOf(s);
    const winner = key === null ? undefined : winners.get(key);
    if (winner === undefined || winner === s) {
      out.push(s);
      continue;
    }
    sink.excluded[sink.reason]++;
    sink.duplicateOf.set(s.candidate.fileId, winner.candidate.fileId);
    if (sink.copiesOf) {
      const list = sink.copiesOf.get(winner.candidate.fileId) ?? [];
      list.push(s);
      sink.copiesOf.set(winner.candidate.fileId, list);
    }
  }
  return out;
}
