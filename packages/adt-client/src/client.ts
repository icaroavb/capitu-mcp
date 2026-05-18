import { ADTClient } from 'abap-adt-api';
import type {
  ActivationResultDigest,
  AdtConnectionOptions,
  LockHandle,
  ObjectSource,
  PackageContents,
  PackageNode,
  SearchHit,
  SyntaxFinding,
  TransportContents,
  TransportSummary,
  UsageRef,
} from './types.js';

/**
 * Minimal facade over abap-adt-api with capitu-specific normalization.
 *
 * Why a facade?
 *  1. abap-adt-api types are loose — fields come from XML and casing varies.
 *  2. We want one place to enforce login state, redact secrets in errors,
 *     and (later) integrate with the compliance gate from @capitu/kb.
 *  3. capitu MCPs depend on @capitu/adt-client, not directly on abap-adt-api,
 *     so we can upgrade the underlying lib without ripple.
 */
export class CapituAdtClient {
  private inner: ADTClient;
  private loggedIn = false;
  readonly url: string;
  readonly user: string;
  readonly client?: string;
  readonly language?: string;
  readonly sessionMode: 'stateful' | 'stateless';

  constructor(opts: AdtConnectionOptions) {
    if (opts.insecureSkipTlsVerify) {
      // Local-only escape hatch. Caller already accepted the risk.
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    this.inner = new ADTClient(opts.url, opts.user, opts.password, opts.client, opts.language);
    this.url = opts.url;
    this.user = opts.user;
    this.client = opts.client;
    this.language = opts.language;
    this.sessionMode = opts.sessionMode ?? 'stateful';
  }

  /**
   * Establishes session and configures stateful/stateless mode.
   *
   * ADT requires 'stateful' for lock + write + activate. With 'stateless',
   * even the lock() call succeeds but subsequent writeSource fails with
   * "stateful session required". We default to stateful so the full dev cycle
   * works out of the box.
   */
  async connect(): Promise<void> {
    if (this.loggedIn) return;
    await this.inner.login();
    // Setting session mode after login — the property setter on ADTClient
    // sends the appropriate header on the next request.
    (this.inner as unknown as { stateful: string }).stateful = this.sessionMode;
    this.loggedIn = true;
  }

  async disconnect(): Promise<void> {
    if (!this.loggedIn) return;
    try {
      await this.inner.logout();
    } finally {
      this.loggedIn = false;
    }
  }

  /**
   * Search the object directory. Empty `type` searches all types.
   * Pattern follows SAP wildcard conventions: `Z*`, `ZI_FLIGHT*`, `*`.
   */
  async search(pattern: string, type = '', max = 50): Promise<SearchHit[]> {
    await this.connect();
    const raw = await this.inner.searchObject(pattern, type, max);
    return raw.map(toSearchHit);
  }

  /**
   * List immediate contents of a package node.
   * For DEVC/K (development class) the parent is the package name like '$TMP'.
   */
  async listPackage(packageName: string): Promise<PackageContents> {
    await this.connect();
    const raw = await this.inner.nodeContents('DEVC/K', packageName);
    return {
      objects: (raw.nodes ?? []).map(toPackageNode),
      categories: (raw.categories ?? []).map((c) => c.CATEGORY).filter(Boolean),
    };
  }

  /** Fetch the textual source of an ABAP/CDS object by its ADT source URI. */
  async getSource(sourceUri: string): Promise<ObjectSource> {
    await this.connect();
    const source = await this.inner.getObjectSource(sourceUri);
    return { uri: sourceUri, source };
  }

  /**
   * Create a new ABAP/CDS object in a target package.
   *
   * Common object types:
   *   - 'DDLS/DF' — CDS view (data definition)
   *   - 'CLAS/OC' — Global class
   *   - 'INTF/OI' — Global interface
   *   - 'DCLS/DL' — CDS access control
   *   - 'TABL/DT' — Database table
   *   - 'DOMA/DD' — Domain
   *
   * After creation the object is INACTIVE and empty. Use writeSource() to put
   * code in it, then activate(). The parentPath is the ADT path of the package
   * (e.g. /sap/bc/adt/packages/zivb_aprendizagem).
   */
  async createObject(opts: {
    objectType: string;
    name: string;
    description: string;
    packageName: string;
    transport?: string;
  }): Promise<void> {
    await this.connect();
    const parentPath = `/sap/bc/adt/packages/${opts.packageName.toLowerCase()}`;
    // abap-adt-api's createObject is overloaded; we use the options form and
    // cast to its public NewObjectOptions parameter shape (CreatableTypeIds is
    // a string-literal union we don't want to mirror locally).
    await this.inner.createObject({
      objtype: opts.objectType,
      name: opts.name.toLowerCase(),
      parentName: opts.packageName,
      description: opts.description,
      parentPath,
      transport: opts.transport,
      language: this.language,
      masterLanguage: this.language,
    } as Parameters<ADTClient['createObject']>[0]);
  }

  /**
   * Acquire an exclusive lock on an object before writing. The returned
   * lockHandle must be passed to writeSource/activate.
   *
   * accessMode 'MODIFY' is the default for editing. 'SHOW' for read-only.
   */
  async lock(objectUri: string, accessMode = 'MODIFY'): Promise<LockHandle> {
    await this.connect();
    const raw = await this.inner.lock(objectUri, accessMode);
    return {
      uri: objectUri,
      lockHandle: raw.LOCK_HANDLE,
      transport: raw.CORRNR || undefined,
    };
  }

  /** Release a previously acquired lock without writing. */
  async unlock(objectUri: string, lockHandle: string): Promise<void> {
    await this.connect();
    await this.inner.unLock(objectUri, lockHandle);
  }

  /**
   * Write source code to an ABAP/CDS object. Requires an active lock handle.
   * The sourceUri must be the source endpoint (ending in /source/main),
   * not the object URI.
   */
  async writeSource(
    sourceUri: string,
    source: string,
    lockHandle: string,
    transport?: string,
  ): Promise<void> {
    await this.connect();
    await this.inner.setObjectSource(sourceUri, source, lockHandle, transport);
  }

  /**
   * Activate an object. Use the object URI (not the source URI).
   * The mainInclude parameter is required for some types like FUGR.
   */
  async activate(
    objectName: string,
    objectUri: string,
    mainInclude?: string,
  ): Promise<ActivationResultDigest> {
    await this.connect();
    const raw = await this.inner.activate(objectName, objectUri, mainInclude);
    return {
      success: raw.success,
      inactiveObjects: raw.inactive?.length ?? 0,
      messages: (raw.messages ?? []).map((m) => ({
        type: m.type,
        objectDescr: m.objDescr,
        line: m.line,
        href: m.href,
        text: m.shortText,
      })),
    };
  }

  /**
   * Run a syntax check on a source. For CDS objects pass only the CDS URI.
   * For ABAP, pass URI, mainUri (often == URI), and content.
   */
  async syntaxCheck(uri: string, content?: string, mainUri?: string): Promise<SyntaxFinding[]> {
    await this.connect();
    const raw =
      content !== undefined
        ? await this.inner.syntaxCheck(uri, mainUri ?? uri, content)
        : await this.inner.syntaxCheck(uri);
    return raw.map((r) => ({
      severity: (r.severity as SyntaxFinding['severity']) ?? 'info',
      uri: r.uri ?? uri,
      line: r.line ?? 0,
      offset: r.offset ?? 0,
      text: r.text ?? '',
    }));
  }

  /**
   * Find references (where-used) for an object or a symbol within a source.
   * For a whole object, pass just the uri. For a symbol, pass line+column too.
   */
  async findReferences(uri: string, line?: number, column?: number): Promise<UsageRef[]> {
    await this.connect();
    const raw = await this.inner.usageReferences(uri, line, column);
    return raw.map((r) => ({
      uri: r.uri ?? '',
      type: r['adtcore:type'] ?? '',
      name: r['adtcore:name'] ?? '',
      parent: r.parentUri,
      packageName: r.packageRef?.['adtcore:name'],
      description: r['adtcore:description'],
    }));
  }

  /**
   * List transport requests of a user. Returns a flat array of summaries
   * across workbench + customizing, modifiable + released.
   */
  async listTransports(user?: string): Promise<TransportSummary[]> {
    await this.connect();
    const tu = await this.inner.userTransports(user ?? this.user, true);
    const out: TransportSummary[] = [];
    const collect = (
      targets: typeof tu.workbench,
      workbench: boolean,
    ): void => {
      for (const target of targets) {
        for (const state of ['modifiable', 'released'] as const) {
          for (const req of target[state]) {
            out.push({
              number: req['tm:number'],
              owner: req['tm:owner'],
              description: req['tm:desc'],
              status: req['tm:status'],
              state,
              targetName: target['tm:name'],
              workbench,
              objectCount: (req.objects?.length ?? 0) + sumObjectsInTasks(req.tasks),
            });
          }
        }
      }
    };
    collect(tu.workbench, true);
    collect(tu.customizing, false);
    return out;
  }

  /**
   * Detail of a single transport request: tasks, owner per task, and the
   * objects each task contains.
   */
  async transportContents(transportNumber: string): Promise<TransportContents> {
    await this.connect();
    const raw = (this.inner as unknown as {
      transportDetails: (n: string) => Promise<{
        'tm:number': string;
        'tm:owner': string;
        'tm:desc': string;
        'tm:status': string;
        objects?: TransportRawObject[];
        tasks?: TransportRawTask[];
      }>;
    }).transportDetails;
    if (typeof raw !== 'function') {
      throw new Error(
        'abap-adt-api: transportDetails not exposed on ADTClient. Update the library or use raw.transportDetails directly.',
      );
    }
    const detail = await raw.call(this.inner, transportNumber);
    const tasks = (detail.tasks ?? []).map(taskToDetail);
    const ownObjects = (detail.objects ?? []).map(rawObjectToObject);
    const allObjects = [...ownObjects, ...tasks.flatMap((t) => t.objects)];
    return {
      number: detail['tm:number'],
      owner: detail['tm:owner'],
      description: detail['tm:desc'],
      status: detail['tm:status'],
      tasks,
      allObjects,
    };
  }

  /** Direct access to underlying client for advanced or unsupported calls. */
  get raw(): ADTClient {
    return this.inner;
  }

  isConnected(): boolean {
    return this.loggedIn;
  }
}

// --- Normalization helpers ----------------------------------------------------

interface AdtCoreFields {
  'adtcore:uri'?: string;
  'adtcore:type'?: string;
  'adtcore:name'?: string;
  'adtcore:packageName'?: string;
  'adtcore:description'?: string;
}

function toSearchHit(raw: unknown): SearchHit {
  const r = raw as AdtCoreFields;
  return {
    uri: r['adtcore:uri'] ?? '',
    type: r['adtcore:type'] ?? '',
    name: r['adtcore:name'] ?? '',
    packageName: r['adtcore:packageName'],
    description: r['adtcore:description'],
  };
}

// --- Transport normalization -------------------------------------------------

interface TransportRawObject {
  'tm:pgmid': string;
  'tm:type': string;
  'tm:name': string;
  'tm:obj_info'?: string;
}

interface TransportRawTask {
  'tm:number': string;
  'tm:owner': string;
  'tm:desc': string;
  'tm:status': string;
  objects?: TransportRawObject[];
}

function sumObjectsInTasks(tasks: TransportRawTask[] | undefined): number {
  return (tasks ?? []).reduce((sum, t) => sum + (t.objects?.length ?? 0), 0);
}

function rawObjectToObject(o: TransportRawObject): {
  pgmid: string;
  type: string;
  name: string;
  info?: string;
} {
  return {
    pgmid: o['tm:pgmid'],
    type: o['tm:type'],
    name: o['tm:name'],
    info: o['tm:obj_info'],
  };
}

function taskToDetail(t: TransportRawTask): {
  number: string;
  owner: string;
  description: string;
  status: string;
  objects: ReturnType<typeof rawObjectToObject>[];
} {
  return {
    number: t['tm:number'],
    owner: t['tm:owner'],
    description: t['tm:desc'],
    status: t['tm:status'],
    objects: (t.objects ?? []).map(rawObjectToObject),
  };
}

function toPackageNode(raw: unknown): PackageNode {
  // nodeContents() returns Node[] with TADIR-style upper-case fields.
  // PACKAGE_NAME is not exposed at the node level — the parent package is
  // already implicit in the listPackage(name) call.
  const r = raw as {
    OBJECT_URI?: string;
    OBJECT_TYPE?: string;
    OBJECT_NAME?: string;
    DESCRIPTION?: string;
  };
  return {
    uri: r.OBJECT_URI ?? '',
    type: r.OBJECT_TYPE ?? '',
    name: r.OBJECT_NAME ?? '',
    description: r.DESCRIPTION,
  };
}
