export {
  fuse,
  experienceHash,
  experienceId,
  linkId,
  highestSeniority,
  uuidFromText,
  validationLabel,
} from './fuse';
export { runFusion, DEFAULT_CHUNK_SIZE } from './run';
export {
  rollUp,
  staffAccountHash,
  staffAccountId,
  staffCampaignHash,
  staffCampaignId,
  staffWorkLinkId,
} from './rollup';
export type {
  FusionDeps,
  FusionLogger,
  FusionOptions,
  FusionReport,
  FusionAccountReport,
} from './run';
export { parseFusionArgs } from './args';
export type { FusionArgs } from './args';
export { scoreClaim, round3 } from './score';
export { compareExtractorVersion, supersedeByVersion } from './supersede';
export { compareLoad, keepNewestLoadPerFile } from './newest-load';
export { FUSION_VERSION, FUSION_SYNC_SOURCE, STAFF_WORK_SOURCE } from './constants';
export type {
  ActivityHorizon,
  CatalogLoader,
  EvidenceReader,
  ExperienceDraft,
  FusedClaim,
  FusionAccount,
  FusionCampaign,
  FusionCatalog,
  FusionEvidence,
  FusionInput,
  FusionMetrics,
  FusionOutput,
  FusionPiece,
  FusionRunStore,
  FusionStaff,
  StaffAccountDraft,
  StaffCampaignDraft,
  StaffLoader,
  StaffWorkRollup,
  StaffWorkWriter,
  ValidationLabel,
  WriteCounts,
} from './types';
