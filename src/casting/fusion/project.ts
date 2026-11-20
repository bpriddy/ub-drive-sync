/**
 * Canonical project identity for fusion.
 *
 * Tiers name the same project in different ways: T1 by job number, campaign or a
 * folder-name key; T2 by job number or campaign; T3 passes through whatever T1
 * gave its candidate. A claim is corroborated only by rows of the SAME project,
 * so every row is mapped onto one key with a fixed ladder, finest first:
 *
 *   1. piece       `piece:<id>`            piece_id known to the catalog, or a job
 *                                          number that names a catalog piece
 *   2. job         `job:<account>:<code>`  a job number the catalog does not know
 *   3. campaign    `campaign:<id>`         campaign_id known to the catalog
 *   4. name        `name:<account>:<key>`  T1 name-keyed project (location `name:<key>`)
 *   5. none        null                    no project: such a claim is never served
 *
 * Ids the catalog does not know are ignored, not trusted (a foreign key would
 * refuse them, and a campaign of another account must never lend its attributes
 * to this account's claim). The ladder is a known limit: a row that names only
 * the campaign does not corroborate a row that names a piece of it.
 */
import type { FusionCampaign, FusionEvidence, FusionPiece } from './types';

export interface ProjectRef {
  /** null = no project reference at all. */
  key: string | null;
  jobNumber: string | null;
  campaignId: string | null;
  pieceId: string | null;
  campaign: FusionCampaign | null;
  piece: FusionPiece | null;
}

export type ProjectResolver = (row: FusionEvidence) => ProjectRef;

const NAME_PREFIX = 'name:';

export function createProjectResolver(
  campaigns: readonly FusionCampaign[],
  pieces: readonly FusionPiece[],
): ProjectResolver {
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const pieceById = new Map(pieces.map((p) => [p.id, p]));
  const pieceByJob = new Map<string, FusionPiece>();
  for (const p of [...pieces].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (p.jobNumber !== null && !pieceByJob.has(p.jobNumber)) pieceByJob.set(p.jobNumber, p);
  }

  const campaignOf = (id: string | null, accountId: string): FusionCampaign | null => {
    if (id === null) return null;
    const c = campaignById.get(id);
    return c !== undefined && c.accountId === accountId ? c : null;
  };

  return (row) => {
    let piece: FusionPiece | null = null;
    if (row.pieceId !== null) piece = pieceById.get(row.pieceId) ?? null;
    if (piece === null && row.jobNumber !== null) piece = pieceByJob.get(row.jobNumber) ?? null;
    // A piece whose campaign belongs to another account is not this account's project.
    const pieceCampaign = piece === null ? null : campaignOf(piece.campaignId, row.accountId);
    if (piece !== null && pieceCampaign !== null) {
      return {
        key: `piece:${piece.id}`,
        jobNumber: piece.jobNumber ?? row.jobNumber,
        campaignId: pieceCampaign.id,
        pieceId: piece.id,
        campaign: pieceCampaign,
        piece,
      };
    }

    const campaign = campaignOf(row.campaignId, row.accountId);
    if (row.jobNumber !== null) {
      return {
        key: `job:${row.accountId}:${row.jobNumber}`,
        jobNumber: row.jobNumber,
        campaignId: campaign?.id ?? null,
        pieceId: null,
        campaign,
        piece: null,
      };
    }
    if (campaign !== null) {
      return {
        key: `campaign:${campaign.id}`,
        jobNumber: null,
        campaignId: campaign.id,
        pieceId: null,
        campaign,
        piece: null,
      };
    }
    const nameKey =
      row.source === 'drive_metadata' &&
      row.location !== null &&
      row.location.startsWith(NAME_PREFIX) &&
      row.location.length > NAME_PREFIX.length
        ? row.location.slice(NAME_PREFIX.length)
        : null;
    return {
      key: nameKey === null ? null : `name:${row.accountId}:${nameKey}`,
      jobNumber: null,
      campaignId: null,
      pieceId: null,
      campaign: null,
      piece: null,
    };
  };
}
