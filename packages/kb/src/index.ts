export { openKb, defaultDbPath, type OpenOptions } from './db.js';
export { EMBEDDING_DIM, SCHEMA_VERSION } from './schema.js';
export { insertDoc, getDoc, countDocs, deleteBySource } from './docs.js';
export { searchDocs, type SearchOptions } from './search.js';
export {
  insertLearning,
  validateLearning,
  searchLearnings,
} from './learnings.js';
export { upsertCatalog, listCatalog } from './tenant.js';
export { recordTrace, withTrace } from './traces.js';
export {
  insertProposal,
  getProposal,
  listProposals,
  updateProposalStatus,
  newProposalToken,
  type ProposalRecord,
  type ProposalStatus,
} from './proposals.js';
export {
  resolveOutputDir,
  categoryDir,
  buildFilename,
  markdownToDocxBuffer,
  writeMarkdownAsDocx,
  writeMarkdownAsMd,
  listOutputs,
  ensureOutputDirsExist,
  type OutputCategory,
  type OutputListing,
  type WriteResult,
} from './output.js';
export {
  VoyageEmbeddings,
  LocalEmbeddings,
  NullEmbeddings,
  FakeEmbeddings,
  resolveEmbeddingsProvider,
  type EmbeddingsProvider,
  type VoyageOptions,
  type LocalEmbeddingsOptions,
} from './embeddings.js';
export {
  loadComplianceFromEnv,
  evaluate as evaluateCompliance,
  assertAllowed as assertCompliance,
  isEndorsed,
  isGrayZone,
  CompliancePolicyViolation,
  type ComplianceContext,
  type ComplianceMode,
  type ComplianceDecision,
  type ToolCategory,
} from './compliance.js';
export {
  loadInstanceProfiles,
  instancesPath,
  getActiveInstance,
  setActiveInstance,
  resolvePassword,
  resolveCookie,
  resolveBearer,
  isToolEnabled,
  ACTIVE_INSTANCE_META_KEY,
  type InstanceProfile,
  type InstanceProfilesResult,
  type InstanceAuthMode,
  type SapEditionHint,
} from './instances.js';
export type {
  DocChunk,
  StoredDoc,
  DocSource,
  Learning,
  StoredLearning,
  LearningKind,
  TenantCatalogEntry,
  TenantCatalogType,
  Trace,
  SearchHit,
} from './types.js';
