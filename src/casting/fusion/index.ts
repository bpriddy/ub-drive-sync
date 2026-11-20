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
export type {
  FusionDeps,
  FusionLogger,
  FusionOptions,
  FusionReport,
  FusionAccountReport,
} from './run';
export { parseFusionArgs } from './args';
export type { FusionArgs } from './args';
export { scoreClaim, budgetBand, round3 } from './score';
export { compareExtractorVersion, supersedeByVersion } from './supersede';
export { FUSION_VERSION, FUSION_SYNC_SOURCE } from './constants';
export type {
  ActivityHorizon,
  CatalogLoader,
  EvidenceReader,
  ExperienceDraft,
  ExperienceWriter,
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
  StaffLoader,
  ValidationLabel,
} from './types';
