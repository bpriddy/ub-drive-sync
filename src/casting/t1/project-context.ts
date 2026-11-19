/**
 * Project context of one indexed file, derived from its folder breadcrumb.
 *
 * The index stores `path` as ` / `-separated names; the last segment is the
 * file's own name, the first is the root the scan was for (the account for v2
 * rows, the campaign for legacy v1 campaign rows). Nothing here looks at a file
 * date: a file date is not a project date (uploads keep their source mtime,
 * migrations reset createdTime, placeholder dates exist).
 *
 * Identity ladder, strongest first:
 *   1. job code in a folder name (strict bracket > bracket variant > unbracketed);
 *   2. the campaign the index attributes the file to (folder attribution);
 *   3. a name key: the first folder below the root that is not a generic
 *      container (a year, "Archive", ...). Weakest: a name is not an identity.
 *   4. none: the file says nothing about a project.
 */
import { type JobCodeHit, JOB_CODE_FORM_RANK, recogniseJobCode } from './job-code';

const SEPARATOR = ' / ';

/** Generic folder names that group projects without being one. [ASSUME: tune on S4.5 dry-run output.] */
export const DEFAULT_CONTAINER_SEGMENTS: readonly string[] = [
  'archive',
  'archives',
  'current projects',
  'projects',
  'active projects',
  'past projects',
  'assets',
  'brand assets',
  'shared',
  'misc',
  'miscellaneous',
  'other',
  'work',
  'work in progress',
  'wip',
  'final',
  'finals',
];

export type ProjectStrength = 'job_code' | 'job_code_weak' | 'campaign' | 'name_key' | 'none';

export interface ProjectContext {
  /** Stable aggregation key within an account, or null when the file names no project. */
  projectKey: string | null;
  strength: ProjectStrength;
  jobCode: JobCodeHit | null;
  /** Normalised name key (strength name_key only). */
  nameKey: string | null;
  /** Folder segments from the root down to the project folder, original spelling. */
  contextSegments: readonly string[];
}

export function splitPath(path: string | null, fileName: string): string[] {
  if (!path) return [];
  const parts = path
    .split(SEPARATOR)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // The breadcrumb ends with the file's own name; the folders are what is above it.
  if (parts.length > 0 && parts[parts.length - 1] === fileName.trim()) parts.pop();
  return parts;
}

/** Lower-case, diacritics folded, ordinal prefix ("02. ") and extra spaces removed. */
export function normaliseSegment(segment: string): string {
  return segment
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/^\s*\d{1,3}\s*[.)_-]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const YEAR_ONLY =
  /^(?:fy\s?)?(?:(?:19|20)\d{2}|\d{2})(?:\s*[-–—/]\s*(?:fy\s?)?(?:(?:19|20)\d{2}|\d{2}))?$/;

function isContainer(segment: string, containers: ReadonlySet<string>): boolean {
  const n = normaliseSegment(segment);
  return n.length === 0 || YEAR_ONLY.test(n) || containers.has(n);
}

export interface ContextOptions {
  knownPrefixes: ReadonlySet<string>;
  containerSegments?: ReadonlySet<string>;
}

let defaultContainers: ReadonlySet<string> | null = null;
function containersOf(options: ContextOptions): ReadonlySet<string> {
  if (options.containerSegments) return options.containerSegments;
  defaultContainers ??= new Set(DEFAULT_CONTAINER_SEGMENTS);
  return defaultContainers;
}

/** Best job code among the folder segments: strongest form first, then the deepest. */
function pickJobCode(
  folders: readonly string[],
  knownPrefixes: ReadonlySet<string>,
): { hit: JobCodeHit; depth: number } | null {
  let best: { hit: JobCodeHit; depth: number } | null = null;
  folders.forEach((segment, depth) => {
    const hit = recogniseJobCode(segment, knownPrefixes);
    if (hit === null) return;
    if (
      best === null ||
      JOB_CODE_FORM_RANK[hit.form] < JOB_CODE_FORM_RANK[best.hit.form] ||
      (hit.form === best.hit.form && depth > best.depth)
    ) {
      best = { hit, depth };
    }
  });
  return best;
}

/**
 * The project of one file. `campaignId` is the index's folder attribution.
 * The folder list never contains the file's own name; the file's own name is
 * not searched for a code, since a file name is not a project folder.
 */
export function deriveProjectContext(
  file: { path: string | null; name: string; campaignId: string | null },
  options: ContextOptions,
): ProjectContext {
  const folders = splitPath(file.path, file.name);

  const job = pickJobCode(folders, options.knownPrefixes);
  if (job !== null) {
    return {
      projectKey: `job:${job.hit.code}`,
      strength: job.hit.form === 'bracket' ? 'job_code' : 'job_code_weak',
      jobCode: job.hit,
      nameKey: null,
      contextSegments: folders.slice(0, job.depth + 1),
    };
  }

  if (file.campaignId !== null) {
    return {
      projectKey: `campaign:${file.campaignId}`,
      strength: 'campaign',
      jobCode: null,
      nameKey: null,
      contextSegments: folders,
    };
  }

  const containers = containersOf(options);
  // Segment 0 is the scan root (account or campaign), never a project.
  for (let depth = 1; depth < folders.length; depth++) {
    const segment = folders[depth] as string;
    if (isContainer(segment, containers)) continue;
    // The whole path below the root, container years included: the same project
    // name under two year folders stays two projects.
    const key = folders
      .slice(1, depth + 1)
      .map(normaliseSegment)
      .join(SEPARATOR);
    return {
      projectKey: `name:${key}`,
      strength: 'name_key',
      jobCode: null,
      nameKey: key,
      contextSegments: folders.slice(0, depth + 1),
    };
  }

  return {
    projectKey: null,
    strength: 'none',
    jobCode: null,
    nameKey: null,
    contextSegments: folders,
  };
}
