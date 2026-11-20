/**
 * The real data wiring of the pilot driver: the account's Drive root from the database,
 * a live Drive listing (read-only calls through the repo's own client) and the staff roster.
 *
 * Lazy like real-llm.ts and real-reader.ts: config, Prisma and the Drive client are loaded by
 * dynamic import inside the functions, never at import time, so importing the pilot core or
 * its tests can never build a client. Reads only: there is no write call in this file, and no
 * model client anywhere in its import closure (a test walks it).
 */
import type { TraversedFile } from '../../drive/types';
import type { RosterIndex } from '../identity';
import { toCandidates } from './listing-candidates';
import type { T3Candidate } from './types';

const ROOT_LABEL = 'root';

export async function loadAccountCandidates(accountId: string): Promise<T3Candidate[]> {
  const { prisma } = await import('../../prisma');
  const { PgAccountReader } = await import('../t2/backfill/pg-adapters');
  const rootId = await new PgAccountReader(prisma).driveRoot(accountId);
  if (rootId === null) throw new Error('the account has no drive_folder_id');

  const { probeFolder, isListingUnavailableError } = await import('../../drive/client');
  const { listSubtreeFiles } = await import('../../drive/subtree');
  const { traverseFolder } = await import('../../drive/traversal');
  const probe = await probeFolder(rootId);
  if (probe.driveId) {
    try {
      const { files } = await listSubtreeFiles(rootId, ROOT_LABEL, probe.driveId);
      return toCandidates(files, accountId);
    } catch (err) {
      if (probe.isSharedDriveRoot || !isListingUnavailableError(err)) throw err;
    }
  }
  const walked: TraversedFile[] = [];
  for await (const f of traverseFolder(rootId, ROOT_LABEL)) if (!f.isFolder) walked.push(f);
  return toCandidates(walked, accountId);
}

export async function loadRosterIndex(): Promise<RosterIndex> {
  const { prisma } = await import('../../prisma');
  const { loadRoster } = await import('../t1/pg-adapters');
  const { buildRosterIndex } = await import('../identity');
  const domains = (process.env['CASTING_AGENCY_EMAIL_DOMAINS'] ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  return buildRosterIndex(await loadRoster(prisma), { agencyEmailDomains: domains });
}

export async function closeRealIo(): Promise<void> {
  const { prisma } = await import('../../prisma');
  await prisma.$disconnect();
}
