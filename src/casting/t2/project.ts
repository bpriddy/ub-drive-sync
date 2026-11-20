/**
 * File -> project, resolved at query time from the Drive index and the
 * accounts database. Nothing is stored in `drive_edit_stats` for this, so a
 * re-attribution of a file (a folder move, a campaign merge) is picked up by
 * the next run.
 *
 * Ladder (T2 is weaker than T1, so there is no name-key rung: a folder name
 * is not an identity, and T2 has no job skeleton to aggregate it into):
 *   1. a strict or variant bracket job code in a folder name (the unbracketed
 *      shape needs the T1 prefix census and is switched off here);
 *      the code's piece and campaign come from the catalog when known;
 *   2. the campaign the index attributes the file to (folder attribution).
 * A campaign or piece id the catalog does not know is dropped (foreign keys
 * would refuse it); a file left with neither a job number nor a campaign has
 * no project and yields no row.
 */
import { deriveProjectContext } from '../t1/project-context';
import type { IndexFileRow, ProjectCatalog } from './types';

export interface T2Project {
  /** Stable key for the claim hash: `job:<code>` or `campaign:<id>`. */
  key: string;
  basis: 'job_code' | 'campaign';
  jobNumber: string | null;
  campaignId: string | null;
  pieceId: string | null;
}

export interface ProjectResolver {
  resolve(file: IndexFileRow): T2Project | null;
}

const NO_PREFIXES: ReadonlySet<string> = new Set<string>();

export function createProjectResolver(catalog: ProjectCatalog): ProjectResolver {
  const campaigns = new Set(catalog.campaigns.map((c) => c.id));
  const pieces = new Map(catalog.pieces.map((p) => [p.jobNumber, p]));
  return {
    resolve(file: IndexFileRow): T2Project | null {
      const ctx = deriveProjectContext(file, { knownPrefixes: NO_PREFIXES });
      const indexCampaign =
        file.campaignId !== null && campaigns.has(file.campaignId) ? file.campaignId : null;

      if (ctx.jobCode !== null) {
        const code = ctx.jobCode.code;
        const piece = pieces.get(code);
        return {
          key: `job:${code}`,
          basis: 'job_code',
          jobNumber: code,
          campaignId: piece !== undefined ? piece.campaignId : indexCampaign,
          pieceId: piece?.id ?? null,
        };
      }
      if (indexCampaign !== null) {
        return {
          key: `campaign:${indexCampaign}`,
          basis: 'campaign',
          jobNumber: null,
          campaignId: indexCampaign,
          pieceId: null,
        };
      }
      return null;
    },
  };
}
