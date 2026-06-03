export {
  CapituAdtClient,
  CapituAdtError,
  decodeXmlEntities,
  isLocalPackage,
} from './client.js';
export { probeEnvironment, classifyEdition } from './probe.js';
export {
  InstanceRegistry,
  type RegistryProfile,
  type RegistryBridge,
  type RegistryAuthMode,
  type InstanceSafety,
  type InstanceSummary,
} from './instance-registry.js';
export {
  probeFeatures,
  classifyFeatureStatus,
  FEATURE_PROBES,
  type FeatureId,
  type FeatureStatus,
} from './features.js';
export { grepSource, type GrepOptions, type GrepResult } from './grep.js';
export {
  AdtPackageHierarchyResolver,
  matchesSubtreeRule,
  type PackageHierarchyResolver,
  type DirectSubpackageFetcher,
  type PackageHierarchyResolverOptions,
} from './package-hierarchy.js';
export {
  BDEF_COLLECTION,
  BDEF_CONTENT_TYPE,
  SRVB_COLLECTION,
  SRVB_CONTENT_TYPE,
  bdefObjectUri,
  bdefSourceUri,
  buildBdefCreateXml,
  buildSrvbCreateXml,
  normalizeSrvbBindingType,
  srvbObjectUri,
  type BdefCreateParams,
  type SrvbCreateParams,
} from './raw-create.js';
export {
  withRetry,
  detectRetryReason,
  summarizeAdtError,
  errorMessage,
  inspectAdtError,
  describeAdtError,
  isAlreadyExistsError,
  isLockedByOtherUserError,
  isPossiblyDirtySession,
  type AdtErrorDetail,
  type RetryReason,
  type RetryContext,
  type WithRetryOptions,
} from './resilience.js';
export type {
  ActivationResultDigest,
  AdtConnectionOptions,
  AuthMode,
  LockHandle,
  ObjectSource,
  PackageContents,
  PackageNode,
  ProbedEnvironment,
  SapEdition,
  SearchHit,
  SyntaxFinding,
  TransportCheckResult,
  TransportContents,
  TransportSummary,
  TransportTaskDetail,
  UsageRef,
} from './types.js';
