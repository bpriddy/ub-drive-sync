/**
 * Pure mapping from a Drive listing (the repo's `TraversedFile`) to the stage's
 * `T3Candidate`: metadata only, no content. Used by the pilot driver's live
 * listing (real-pilot-io.ts) and covered by tests on synthetic listings.
 *
 * The listing's `path` is the breadcrumb of the file itself (folders from the
 * root label down, then the file name). The candidate's `ancestors` are the
 * folders only. A project reference is derived only from what a bare listing
 * carries: a strict bracket job code in a folder name, deepest folder first.
 * Campaign and piece references come from the T1 skeleton, not from a listing.
 */
import { extractJobNumber } from '../../drive/job-number';
import type { TraversedFile } from '../../drive/types';
import type { T3Candidate } from './types';

const SEP = ' / ';

export function ancestorsOf(file: Pick<TraversedFile, 'name' | 'path'>): string[] {
  const parts = file.path.split(SEP);
  if (parts.length > 1 && parts[parts.length - 1] === file.name) parts.pop();
  return parts;
}

export function jobNumberOf(ancestors: readonly string[]): string | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const code = extractJobNumber(ancestors[i] as string);
    if (code !== null) return code;
  }
  return null;
}

export function toCandidate(file: TraversedFile, accountId: string): T3Candidate {
  const ancestors = ancestorsOf(file);
  const jobNumber = jobNumberOf(ancestors);
  return {
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    ancestors,
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
    accountId,
    md5Checksum: file.md5Checksum ?? null,
    ...(jobNumber !== null ? { projectRef: { jobNumber } } : {}),
  };
}

/**
 * Folders are not documents. Shortcuts stay in: the shortlist step counts them as
 * `unsupported_mime`, so the exclusion numbers stay honest.
 */
export function toCandidates(files: readonly TraversedFile[], accountId: string): T3Candidate[] {
  return files.filter((f) => !f.isFolder).map((f) => toCandidate(f, accountId));
}
