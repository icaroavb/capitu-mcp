/**
 * Public types for @capitu/adt-client.
 *
 * Stays minimal and stable: only the surface that capitu MCPs consume.
 * The underlying abap-adt-api types are kept internal.
 */

export type SapEdition =
  | 'on-prem'
  | 'pce' // S/4HANA Cloud Private Edition (RISE)
  | 'public-cloud' // S/4HANA Cloud Public Edition (ABAP Cloud strict)
  | 'btp-abap' // BTP ABAP Environment (Steampunk)
  | 'unknown';

export type AuthMode = 'basic' | 'service-key';

export interface AdtConnectionOptions {
  url: string;
  user: string;
  password: string;
  client?: string;
  /**
   * Logon language (e.g. 'PT', 'EN', 'DE'). Important: SAP refuses to create
   * objects when the session language differs from the system's installation
   * language. For S/4HANA installed in pt-BR, use 'PT'.
   */
  language?: string;
  /**
   * Session mode. ADT requires 'stateful' for write operations (lock + write
   * + activate). 'stateless' is fine for read-only. Default: 'stateful' so
   * the full dev workflow is supported out of the box.
   */
  sessionMode?: 'stateful' | 'stateless';
  authMode?: AuthMode;
  /** Allow self-signed certificates (sandbox only). */
  insecureSkipTlsVerify?: boolean;
}

/**
 * Result of probeEnvironment(): everything we can learn about the target
 * system without writing anything.
 *
 * Used by capitu-docs to pin documentation versions, and by capitu-dev to
 * adapt safety gates per edition.
 */
export interface ProbedEnvironment {
  url: string;
  edition: SapEdition;
  /** SAP_BASIS release like "758" (= 7.58), or null if unavailable. */
  sapBasisRelease: string | null;
  /** Human-readable system info string, exactly as returned by ADT. */
  systemInfo?: string;
  /** Number of object types exposed via ADT (sanity signal). */
  objectTypeCount: number;
  /** Probed at this timestamp. */
  probedAt: string;
  /** Latency of the probe round-trip. */
  durationMs: number;
}

export interface SearchHit {
  /** ADT URI, e.g. /sap/bc/adt/oo/classes/cl_abap_typedescr */
  uri: string;
  /** Object type code, e.g. "DDLS/DF", "CLAS/OC". */
  type: string;
  /** Object name as-is. */
  name: string;
  /** Package containing the object. */
  packageName?: string;
  /** Optional description. */
  description?: string;
}

export interface ObjectSource {
  uri: string;
  source: string;
  /** ETag returned by SAP for caching/revalidation. */
  etag?: string;
}

export interface PackageNode {
  uri: string;
  type: string;
  name: string;
  description?: string;
}

export interface PackageContents {
  /** Direct child objects (in any category). */
  objects: PackageNode[];
  /**
   * Sub-categories that exist but require a second nodeContents() call to
   * enumerate. Example: ['core_data_services', 'classes'].
   */
  categories: string[];
}

/**
 * Result of a lock() call. Pass the lockHandle to writeSource/activate.
 * Locks must be released by activating or by explicit unlock.
 */
export interface LockHandle {
  uri: string;
  lockHandle: string;
  transport?: string;
}

export interface SyntaxFinding {
  severity: 'error' | 'warning' | 'info';
  uri: string;
  line: number;
  offset: number;
  text: string;
}

export interface ActivationResultDigest {
  success: boolean;
  inactiveObjects: number;
  messages: Array<{
    type: string;
    objectDescr?: string;
    line?: number;
    href?: string;
    text: string;
  }>;
}

export interface UsageRef {
  uri: string;
  type: string;
  name: string;
  parent?: string;
  packageName?: string;
  description?: string;
}

export interface TransportSummary {
  number: string;
  owner: string;
  description: string;
  /** SAP status code. Common values: 'D' modifiable, 'L' locked, 'R' released, 'N' new. */
  status: string;
  /** 'modifiable' (open for edits) or 'released' (sealed). */
  state: 'modifiable' | 'released';
  /** Target system info (e.g. 'PRD'). */
  targetName?: string;
  /** True if this is a workbench transport (objects), false for customizing. */
  workbench: boolean;
  objectCount: number;
}

export interface TransportTaskDetail {
  number: string;
  owner: string;
  description: string;
  status: string;
  objects: Array<{
    pgmid: string;
    type: string;
    name: string;
    info?: string;
  }>;
}

export interface TransportContents {
  number: string;
  owner: string;
  description: string;
  status: string;
  /** Sub-tasks of the request (one per developer who contributed). */
  tasks: TransportTaskDetail[];
  /** Flat list of all objects across all tasks (for quick scan). */
  allObjects: TransportTaskDetail['objects'];
}

/**
 * Result of POST /sap/bc/adt/cts/transportchecks — the read-only pre-flight
 * the ADT calls before any create/update. Tells us, without mutating anything,
 * whether a `(objectUrl, packageName, operation)` triple would be accepted.
 *
 * This is the canonical way to diagnose TO-142 ("cannot assign object X to
 * package Y"), TO-131 ("namespace requires transport"), package "Adding
 * Objects Allowed=false", transport-layer mismatches, and software-component
 * non-modifiability — all without writing to SAP.
 */
export interface TransportCheckResult {
  /** True when SAP requires a corrNr for this op (X = required, '' = not). */
  recordingRequired: boolean;
  /** True when the package is local ($* or DLVUNIT='LOCAL'). */
  isLocal: boolean;
  /** Delivery unit / software component (e.g. 'HOME', 'LOCAL', 'SAP_BASIS'). */
  deliveryUnit: string;
  /** The DEVCLASS the check resolved against (echo of input). */
  devclass: string;
  /** TRs the user could attach the object to (modifiable, owned by user). */
  candidateTransports: Array<{ number: string; description: string; owner: string }>;
  /** If the object is already locked elsewhere, the TR holding it. */
  lockedInTransport?: string;
  /** Errors raised by transportchecks itself (e.g. "package not found"). */
  errors: string[];
  /** Warnings (non-fatal, e.g. "package switched to local at last save"). */
  warnings: string[];
}
