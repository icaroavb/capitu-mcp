import { ADTClient } from 'abap-adt-api';
import {
  BDEF_COLLECTION,
  BDEF_CONTENT_TYPE,
  type BdefCreateParams,
  SRVB_COLLECTION,
  SRVB_CONTENT_TYPE,
  type SrvbCreateParams,
  bdefObjectUri,
  buildBdefCreateXml,
  buildSrvbCreateXml,
  srvbObjectUri,
} from './raw-create.js';
import {
  describeAdtError,
  detectRetryReason,
  inspectAdtError,
  isPossiblyDirtySession,
  withRetry,
} from './resilience.js';
import type {
  ActivationResultDigest,
  AdtConnectionOptions,
  LockHandle,
  ObjectSource,
  PackageContents,
  PackageNode,
  SearchHit,
  SyntaxFinding,
  TransportCheckResult,
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
  /** Cached so retry paths can rebuild a fresh ADTClient when the stateful session goes dirty. */
  private readonly connOpts: AdtConnectionOptions;
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
    this.connOpts = opts;
    this.inner = buildInner(opts);
    this.url = opts.url;
    this.user = opts.user;
    this.client = opts.client;
    this.language = opts.language;
    this.sessionMode = opts.sessionMode ?? 'stateful';
  }

  /**
   * Tear down the current ADTClient and start a brand-new one with the
   * original credentials. Used after a stateful session has been polluted by
   * a rejected POST — even successful subsequent calls then return 400 until
   * the session is recycled.
   *
   * NOT for general use. The withResilient retry path calls this when the
   * detector flags `stateful-dirty`.
   */
  private async recycleSession(): Promise<void> {
    // best-effort logout on the dirty session so the server releases cookies
    try {
      if (this.loggedIn) await this.inner.logout();
    } catch {
      // ignore — the session may already be in a state where logout fails
    }
    this.loggedIn = false;
    this.inner = buildInner(this.connOpts);
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
    try {
      await this.inner.login();
    } catch (err) {
      throw wrapAdtError(err, `connect(${this.user}@${this.url})`);
    }
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
   * Run an ADT call with:
   *   - lazy connect
   *   - automatic re-login + retry on stale 401
   *   - automatic retry on transient network blips
   *
   * Activation has its own retry strategy (ED064) at the activate() method.
   * Generic reads/writes funnel through here so a single expired cookie
   * never sinks an interactive Claude Code session.
   */
  private async withResilient<T>(fn: () => Promise<T>, opLabel: string): Promise<T> {
    await this.connect();
    try {
      return await withRetry(
        async (attempt) => {
          if (attempt > 1) {
            // On retry, fully recycle the inner ADTClient. Just re-logging in
            // doesn't clear a dirty stateful session on the SAP side — the
            // existing connection's server-side context still has the
            // poisoned transaction frame, so subsequent calls keep returning
            // 400/500. Tossing the ADTClient and minting a new one is the
            // documented escape hatch (and what restarting the MCP did).
            await this.recycleSession();
            await this.connect();
          }
          return fn();
        },
        {
          maxRetries: 1,
          delayMs: 200,
          detect: (err) => {
            const reason = detectRetryReason(err);
            if (reason === 'ed064-activation') return null; // handled in activate()
            if (reason) return reason;
            // Stateful-dirty: 400/500 with no real ABAP exception → likely a
            // poisoned session. Only retry once and only on the generic path
            // (writes/reads). Activation has its own retry policy.
            if (isPossiblyDirtySession(err)) return 'stateful-dirty';
            return null;
          },
          onRetry: (ctx) => {
            process.stderr.write(
              `[adt-client] retrying ${opLabel} (reason=${ctx.reason}, attempt=${ctx.attempt})\n`,
            );
          },
        },
      );
    } catch (err) {
      throw wrapAdtError(err, opLabel);
    }
  }

  /**
   * Search the object directory. Empty `type` searches all types.
   * Pattern follows SAP wildcard conventions: `Z*`, `ZI_FLIGHT*`, `*`.
   */
  async search(pattern: string, type = '', max = 50): Promise<SearchHit[]> {
    return this.withResilient(async () => {
      const raw = await this.inner.searchObject(pattern, type, max);
      return raw.map(toSearchHit);
    }, `search(${pattern}, ${type})`);
  }

  /**
   * List immediate contents of a package node.
   * For DEVC/K (development class) the parent is the package name like '$TMP'.
   */
  async listPackage(packageName: string): Promise<PackageContents> {
    return this.withResilient(async () => {
      const raw = await this.inner.nodeContents('DEVC/K', packageName);
      return {
        objects: (raw.nodes ?? []).map(toPackageNode),
        categories: (raw.categories ?? []).map((c) => c.CATEGORY).filter(Boolean),
      };
    }, `listPackage(${packageName})`);
  }

  /**
   * List the DIRECT sub-packages of a package (DEVC/K children only).
   *
   * Used by the `allowedPackages` subtree rule (`ZFOO/**`) via
   * AdtPackageHierarchyResolver. Calls POST /sap/bc/adt/repository/nodestructure
   * with the asx:abap envelope ADT requires (a bare GET returns 406). The shape
   * + filter (DEVC/K only, drop DEVC/KI package-interfaces) is verified against
   * ARC-1's getSubpackages. Names are uppercased + deduped; the queried package
   * itself is excluded.
   */
  async getSubpackages(packageName: string): Promise<string[]> {
    await this.connect();
    const enc = encodeURIComponent(packageName);
    const url = `/sap/bc/adt/repository/nodestructure?parent_type=${encodeURIComponent('DEVC/K')}&parent_name=${enc}&parent_tech_name=${enc}&withShortDescriptions=true`;
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">' +
      '<asx:values><DATA><TV_NODEKEY>000000</TV_NODEKEY></DATA></asx:values>' +
      '</asx:abap>';
    let respBody: string;
    try {
      const resp = await rawAdtPostWithAccept(
        this.inner,
        url,
        body,
        'application/vnd.sap.as+xml; charset=UTF-8; dataname=null',
        'application/vnd.sap.as+xml',
      );
      respBody = resp.body;
    } catch (err) {
      throw wrapAdtError(err, `getSubpackages(${packageName})`);
    }
    const self = packageName.toUpperCase();
    return parseSubpackageNames(respBody).filter((n) => n !== self);
  }

  /**
   * Inspect a package's structural attributes — the ones that control whether
   * objects can be created inside it. Reads the package metadata XML at
   * `/sap/bc/adt/packages/<name>` and surfaces the attributes that matter
   * for TO-142 / TO-131 diagnostics:
   *
   *   - isAddingObjectsAllowed         — false ⇒ ANY create returns TO-142
   *   - isAddingObjectsAllowedEditable — true ⇒ the flag can be toggled in
   *                                      Package Properties; false ⇒ locked
   *                                      by the software-component policy
   *   - transportLayer, softwareComponent, packageType
   *
   * Returning typed fields lets the LLM-caller assert these without parsing
   * XML or hunting through raw `getSource()` output.
   */
  async inspectPackage(packageName: string): Promise<{
    name: string;
    description: string;
    isAddingObjectsAllowed: boolean;
    isAddingObjectsAllowedEditable: boolean;
    packageType: string;
    transportLayer: string;
    softwareComponent: string;
    superPackage: string;
    responsible: string;
    rawXml: string;
  }> {
    await this.connect();
    const url = `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
    let body: string;
    try {
      const resp = await rawAdtGet(this.inner, url, {
        Accept: 'application/vnd.sap.adt.packages.v1+xml',
      });
      body = resp.body;
    } catch (err) {
      throw wrapAdtError(err, `inspectPackage(${packageName})`);
    }
    const attrs = body.match(/<pak:package\b([^>]*)>/)?.[1] ?? '';
    const flag = (name: string) => attr(attrs, name) === 'true';
    const text = (name: string) => attr(attrs, name);
    return {
      name: text('adtcore:name') || packageName.toUpperCase(),
      description: text('adtcore:description'),
      isAddingObjectsAllowed: flag('pak:isAddingObjectsAllowed'),
      isAddingObjectsAllowedEditable: flag('pak:isAddingObjectsAllowedEditable'),
      packageType: text('pak:packageType'),
      transportLayer: text('pak:transportLayer') || innerText(body, 'pak:transportLayer'),
      softwareComponent: text('pak:softwareComponent') || innerText(body, 'pak:softwareComponent'),
      superPackage: innerText(body, 'pak:superPackage') || text('pak:superPackage'),
      responsible: text('adtcore:responsible'),
      rawXml: body,
    };
  }

  /** Fetch the textual source of an ABAP/CDS object by its ADT source URI. */
  async getSource(sourceUri: string): Promise<ObjectSource> {
    return this.withResilient(async () => {
      const source = await this.inner.getObjectSource(sourceUri);
      // decodeXmlEntities preserves "" / undefined; coerce to '' so the return
      // type matches ObjectSource.source (always string).
      return { uri: sourceUri, source: decodeXmlEntities(source) ?? '' };
    }, `getSource(${sourceUri})`);
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
    // $TMP and other local packages reject any corrNr — ADT returns 400
    // "Transport request not allowed for local object". Strip silently.
    const transport = isLocalPackage(opts.packageName) ? undefined : opts.transport;
    const parentPath = `/sap/bc/adt/packages/${opts.packageName.toLowerCase()}`;
    try {
      // abap-adt-api's createObject is overloaded; we use the options form and
      // cast to its public NewObjectOptions parameter shape (CreatableTypeIds is
      // a string-literal union we don't want to mirror locally).
      await this.inner.createObject({
        objtype: opts.objectType,
        name: opts.name.toLowerCase(),
        parentName: opts.packageName,
        description: opts.description,
        parentPath,
        transport,
        language: this.language,
        masterLanguage: this.language,
      } as Parameters<ADTClient['createObject']>[0]);
    } catch (err) {
      throw wrapAdtError(err, `createObject(${opts.objectType} ${opts.name})`);
    }
  }

  /**
   * Create a BDEF (RAP behavior definition) via raw ADT POST.
   *
   * abap-adt-api's createObject() does not include BDEF/BDO in its
   * CreatableTypeIds union, so we send the XML envelope ourselves through the
   * library's HTTP transport (`inner.httpClient.request`). Cookies, CSRF
   * token, and stateful flag are inherited from the existing session.
   *
   * The BDEF created here is empty — only header metadata is registered. To
   * fill it with `define behavior for …` you still need lock → writeSource →
   * unlock → activate, same as every other source-based object. Returns the
   * canonical object URI you can pass to those calls.
   */
  async createBdefRaw(params: BdefCreateParams): Promise<{ objectUri: string; sourceUri: string }> {
    await this.connect();
    const body = buildBdefCreateXml(params);
    const url = buildRawCreateUrl(BDEF_COLLECTION, params.packageName, params.transport);
    try {
      await rawAdtPost(this.inner, url, body, BDEF_CONTENT_TYPE);
    } catch (err) {
      throw wrapAdtError(err, `createBdefRaw(${params.name})`);
    }
    const objectUri = bdefObjectUri(params.name);
    return { objectUri, sourceUri: `${objectUri}/source/main` };
  }

  /**
   * Create a SRVB (service binding) via raw ADT POST.
   *
   * Unlike BDEF, a SRVB has no separate source upload — the XML envelope
   * fully describes the binding. Activation is still required to make the
   * OData service consumable.
   */
  async createSrvbRaw(params: SrvbCreateParams): Promise<{ objectUri: string }> {
    await this.connect();
    const body = buildSrvbCreateXml(params);
    const url = buildRawCreateUrl(SRVB_COLLECTION, params.packageName, params.transport);
    try {
      await rawAdtPost(this.inner, url, body, SRVB_CONTENT_TYPE);
    } catch (err) {
      throw wrapAdtError(err, `createSrvbRaw(${params.name})`);
    }
    return { objectUri: srvbObjectUri(params.name) };
  }

  /**
   * Publish a Service Binding so its OData endpoint becomes reachable.
   *
   * Why we POST this ourselves instead of delegating to
   * `abap-adt-api.publishServiceBinding`: that lib has a parser bug in
   * `build/api/cds.js:135` — it calls `xmlNode(raw, "asx:abap/asx:values/DATA")`
   * passing the path as a SINGLE string. `xmlNode` is variadic
   * (`xmlNode(xml, ...path)`) and treats each arg as one key — so it tries
   * `raw["asx:abap/asx:values/DATA"]` (a key that doesn't exist) and returns
   * `undefined`. Result: severity / shortText / longText ALWAYS undefined,
   * regardless of what the SAP actually returned. The lib's own line 39 in
   * the same file uses the correct multi-arg form, so this is a localized
   * library bug, not an API design choice.
   *
   * Canonical contract (verified against the lib's intent + live PCE):
   *
   *   - URL:  /sap/bc/adt/businessservices/odatav2/publishjobs?servicename=<N>&serviceversion=<V>
   *           (path says odatav2 BUT covers V4 bindings too — single endpoint)
   *   - Headers: only `Accept: application/*` — NO Content-Type override
   *   - Body:  <adtcore:objectReferences><adtcore:objectReference adtcore:name="<N>"/></adtcore:objectReferences>
   *
   * Severity values: 'S' success, 'I' info, 'W' warning, 'E' error,
   * 'A' abort, 'X' system exception. Caller decides what to surface;
   * we don't throw on warnings.
   */
  async publishServiceBinding(
    name: string,
    version = '0001',
  ): Promise<{ severity: string; shortText: string; longText: string }> {
    return this.publishOrUnpublishServiceBinding('publishjobs', name, version);
  }

  /** Reverse of publishServiceBinding — removes the SICF registration. */
  async unpublishServiceBinding(
    name: string,
    version = '0001',
  ): Promise<{ severity: string; shortText: string; longText: string }> {
    return this.publishOrUnpublishServiceBinding('unpublishjobs', name, version);
  }

  /** Shared POST + parse for the publish/unpublish service-binding endpoints. */
  private async publishOrUnpublishServiceBinding(
    action: 'publishjobs' | 'unpublishjobs',
    name: string,
    version: string,
  ): Promise<{ severity: string; shortText: string; longText: string }> {
    await this.connect();
    const qs = new URLSearchParams({ servicename: name, serviceversion: version });
    const url = `/sap/bc/adt/businessservices/odatav2/${action}?${qs.toString()}`;
    const body = `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:name="${name}"/>
</adtcore:objectReferences>`;
    const http = (
      this.inner as unknown as {
        httpClient: {
          request: (
            url: string,
            opts: { method?: string; body?: string; headers?: Record<string, string> },
          ) => Promise<{ status: number; body: string }>;
        };
      }
    ).httpClient;
    if (!http || typeof http.request !== 'function') {
      throw new Error(
        'abap-adt-api: ADTClient.httpClient.request not available. Upgrade the library.',
      );
    }
    let resp: { status: number; body: string };
    try {
      // Note: NO explicit Content-Type — the server picks defaults based on
      // body. With application/* Accept the server returns asx:abap.
      resp = await http.request(url, {
        method: 'POST',
        body,
        headers: { Accept: 'application/*' },
      });
    } catch (err) {
      throw wrapAdtError(err, `${action}(${name} v${version})`);
    }
    return parsePublishResponse(resp.body);
  }

  /**
   * Acquire an exclusive lock on an object before writing. The returned
   * lockHandle must be passed to writeSource/activate.
   *
   * accessMode 'MODIFY' is the default for editing. 'SHOW' for read-only.
   */
  async lock(objectUri: string, accessMode = 'MODIFY'): Promise<LockHandle> {
    await this.connect();
    try {
      const raw = await this.inner.lock(objectUri, accessMode);
      return {
        uri: objectUri,
        lockHandle: raw.LOCK_HANDLE,
        transport: raw.CORRNR || undefined,
      };
    } catch (err) {
      throw wrapAdtError(err, `lock(${objectUri})`);
    }
  }

  /** Release a previously acquired lock without writing. */
  async unlock(objectUri: string, lockHandle: string): Promise<void> {
    await this.connect();
    try {
      await this.inner.unLock(objectUri, lockHandle);
    } catch (err) {
      throw wrapAdtError(err, `unlock(${objectUri})`);
    }
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
    // Empty string is NOT a valid transport for ADT — and a stale ""
    // makes the server reject the PUT with 400 even on $TMP objects.
    const tr = transport?.trim() ? transport : undefined;
    try {
      await this.inner.setObjectSource(sourceUri, source, lockHandle, tr);
    } catch (err) {
      throw wrapAdtError(err, `writeSource(${sourceUri})`);
    }
  }

  /**
   * Write multiple sources to a single ABAP object (main + class-local
   * includes) under ONE lock in ONE stateful HTTP session.
   *
   * Why this exists: RAP behavior pool classes need `main` (global class
   * with FOR BEHAVIOR OF) **plus** `implementations` (the CCIMP include with
   * the local handler class `lhc_*`) to be written together. Two separate
   * `writeSource` calls each lock+unlock — and the SECOND one gets HTTP 404
   * on the include URL because S/4HANA only materializes the include as a
   * standalone resource within the same session that wrote `main`. Once you
   * unlock, the include "evaporates" until the next main-write reopens it.
   *
   * ARC-1's rap-generate.ts (https://github.com/marianfoo/arc-1) does the
   * same thing in `http.withStatefulSession` — we mirror that here.
   *
   * The classObjectUri is the class root (e.g. `/sap/bc/adt/oo/classes/zcl_x`),
   * NOT a source URI. Sources are an ordered list — write `main` first so the
   * includes are bound to the now-fresh class header.
   */
  async writeClassBundle(opts: {
    classObjectUri: string;
    transport?: string;
    sources: Array<{
      /** Where this source lives. Allowed: 'main', 'definitions', 'implementations', 'macros', 'testclasses'. */
      include: 'main' | 'definitions' | 'implementations' | 'macros' | 'testclasses';
      source: string;
    }>;
  }): Promise<{ written: number; lockReleased: boolean }> {
    await this.connect();
    if (opts.sources.length === 0) {
      return { written: 0, lockReleased: true };
    }
    const tr = opts.transport?.trim() ? opts.transport : undefined;
    // We use the inner ADTClient methods directly inside one logical session.
    // abap-adt-api's stateful flag is already on (set in connect()), so the
    // cookie stays glued to the same backend session across these calls.
    const lockResult = await (async () => {
      try {
        return await this.inner.lock(opts.classObjectUri, 'MODIFY');
      } catch (err) {
        throw wrapAdtError(err, `writeClassBundle.lock(${opts.classObjectUri})`);
      }
    })();
    let written = 0;
    let lockReleased = false;
    try {
      // Always write 'main' first if present — the include resources are
      // bound to the class header materialized by the main write.
      const ordered = [...opts.sources].sort((a, b) => {
        if (a.include === 'main') return -1;
        if (b.include === 'main') return 1;
        return 0;
      });
      for (const item of ordered) {
        const sourceUri = buildClassIncludeUri(opts.classObjectUri, item.include);
        try {
          await this.inner.setObjectSource(sourceUri, item.source, lockResult.LOCK_HANDLE, tr);
          written++;
        } catch (err) {
          throw wrapAdtError(err, `writeClassBundle.write(${item.include} → ${sourceUri})`);
        }
      }
    } finally {
      try {
        await this.inner.unLock(opts.classObjectUri, lockResult.LOCK_HANDLE);
        lockReleased = true;
      } catch {
        // best-effort: surface the original write error rather than unlock failure
      }
    }
    return { written, lockReleased };
  }

  /**
   * Activate an object. Use the object URI (not the source URI).
   * The mainInclude parameter is required for some types like FUGR.
   *
   * Retries once on ED064 (RAP behavior handler "Local classes of
   * CL_ABAP_BEHAVIOR_HANDLER…") with a longer pause — the just-written
   * CCDEF/CCIMP isn't always visible to same-request activation. Pattern
   * borrowed from ARC-1 #255.
   */
  async activate(
    objectName: string,
    objectUri: string,
    mainInclude?: string,
  ): Promise<ActivationResultDigest> {
    await this.connect();
    try {
      return await withRetry(
        async () => {
          const raw = await this.inner.activate(objectName, objectUri, mainInclude);
          // ED064 sometimes comes back as success=false with a specific message
          // rather than throwing. Detect and trigger a retry by throwing.
          if (!raw.success) {
            const ed064 = (raw.messages ?? []).find((m) =>
              (m.shortText ?? '').toUpperCase().includes('CL_ABAP_BEHAVIOR_HANDLER'),
            );
            if (ed064) {
              throw new Error(`ED064-LIKE: ${ed064.shortText ?? 'activation coupling'}`);
            }
          }
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
        },
        {
          maxRetries: 1,
          delayMs: 1500, // give the kernel time to publish the written includes
          detect: detectRetryReason,
          onRetry: (ctx) => {
            process.stderr.write(
              `[adt-client] retrying activate(${objectName}) — reason=${ctx.reason}\n`,
            );
          },
        },
      );
    } catch (err) {
      throw wrapAdtError(err, `activate(${objectName})`);
    }
  }

  /**
   * Run a syntax check on a source. For CDS objects pass only the CDS URI.
   * For ABAP, pass URI, mainUri (often == URI), and content.
   */
  async syntaxCheck(uri: string, content?: string, mainUri?: string): Promise<SyntaxFinding[]> {
    await this.connect();
    try {
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
    } catch (err) {
      throw wrapAdtError(err, `syntaxCheck(${uri})`);
    }
  }

  /**
   * Find references (where-used) for an object or a symbol within a source.
   * For a whole object, pass just the uri. For a symbol, pass line+column too.
   */
  async findReferences(uri: string, line?: number, column?: number): Promise<UsageRef[]> {
    return this.withResilient(async () => {
      const raw = await this.inner.usageReferences(uri, line, column);
      return raw.map((r) => ({
        uri: r.uri ?? '',
        type: r['adtcore:type'] ?? '',
        name: r['adtcore:name'] ?? '',
        parent: r.parentUri,
        packageName: r.packageRef?.['adtcore:name'],
        description: decodeXmlEntities(r['adtcore:description']),
      }));
    }, `findReferences(${uri})`);
  }

  /**
   * List transport requests of a user. Returns a flat array of summaries
   * across workbench + customizing, modifiable + released.
   */
  /**
   * Pre-flight an object create/update via POST /sap/bc/adt/cts/transportchecks.
   *
   * This is the read-only diagnostic the ADT itself uses before write
   * operations. It tells us whether the `(objectUrl, devclass, operation)`
   * triple is acceptable WITHOUT mutating anything in SAP. The single most
   * useful tool for diagnosing TO-131 / TO-142 / package-attribute blocks
   * without trial-and-error writes.
   *
   * @param objectUrl  ADT object URL (e.g. `/sap/bc/adt/ddic/domains/zdo_x`)
   * @param devclass   Target package (e.g. `ZN8N`, `$TMP`)
   * @param operation  'I' = insert/create (default), '' = modify
   */
  async checkTransport(
    objectUrl: string,
    devclass: string,
    operation: 'I' | '' = 'I',
  ): Promise<TransportCheckResult> {
    await this.connect();
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
    <DATA>
      <DEVCLASS>${escapeXmlText(devclass)}</DEVCLASS>
      <URI>${escapeXmlText(objectUrl)}</URI>
      <OPERATION>${escapeXmlText(operation)}</OPERATION>
    </DATA>
  </asx:values>
</asx:abap>`;
    let respBody: string;
    try {
      const resp = await rawAdtPostWithAccept(
        this.inner,
        '/sap/bc/adt/cts/transportchecks',
        body,
        'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData',
        'application/vnd.sap.as+xml',
      );
      respBody = resp.body;
    } catch (err) {
      throw wrapAdtError(err, `checkTransport(${objectUrl} → ${devclass})`);
    }
    return parseTransportCheckXml(respBody, devclass);
  }

  /**
   * Pick a sensible default transport when the caller didn't supply one.
   *
   * Strategy:
   *   1. Local package (`$*`)         → no transport needed, return undefined.
   *   2. Otherwise list modifiable workbench TRs owned by the connected user.
   *   3. Return the first one. If there are zero, throw with an actionable
   *      message telling the user to open one in SE09.
   *
   * Cached for the lifetime of the client so we don't hit the SAP TR endpoint
   * once per artifact when applying a multi-object proposal.
   */
  private pickedTransport: string | undefined | null = null; // null = not yet picked
  async pickDefaultTransport(packageName: string): Promise<string | undefined> {
    if (isLocalPackage(packageName)) return undefined;
    if (this.pickedTransport !== null) return this.pickedTransport;
    const trs = await this.listTransports(this.user);
    const open = trs.find((t) => t.state === 'modifiable' && t.workbench);
    if (!open) {
      throw new Error(
        `No open workbench transport found for user ${this.user}. Package '${packageName}' is transportable and requires a corrNr. Open one via SE09 (or pass an explicit transport= argument) and retry.`,
      );
    }
    this.pickedTransport = open.number;
    process.stderr.write(
      `[adt-client] auto-selected transport ${open.number} (${open.description})\n`,
    );
    return this.pickedTransport;
  }

  /** Force a re-pick on the next call. Useful when the user opens a new TR mid-session. */
  resetTransportCache(): void {
    this.pickedTransport = null;
  }

  /**
   * List transport requests owned by a user.
   *
   * IMPORTANT: this method does NOT use abap-adt-api's `userTransports()`.
   * That helper sends `?user=X&targets=true` only, which returns an empty list
   * on S/4HANA PCE (verified live on ndc-s4hana 250). The endpoint requires
   * `requestType=KWT&requestStatus=DR` and singular `target=true` on those
   * releases — same params ARC-1 uses successfully.
   *
   * The response XML also differs by release. Newer S/4 systems emit a flat
   * `<request>` tree with task children inline; older NW emits the legacy
   * `<tm:root><tm:workbench><tm:target>` nesting that abap-adt-api parses.
   * We try the flat shape first (newer, our target) and fall back to the
   * legacy shape so this still works on a sandbox NPL system.
   */
  async listTransports(user?: string): Promise<TransportSummary[]> {
    await this.connect();
    const effectiveUser = user ?? this.user;
    const qs = new URLSearchParams({
      user: effectiveUser,
      target: 'true',
      requestType: 'KWT',
      requestStatus: 'DR',
    });
    const url = `/sap/bc/adt/cts/transportrequests?${qs.toString()}`;
    let body: string;
    try {
      const resp = await rawAdtGet(this.inner, url, {
        Accept: 'application/vnd.sap.adt.transportorganizertree.v1+xml',
      });
      body = resp.body;
    } catch (err) {
      throw wrapAdtError(err, `listTransports(${effectiveUser})`);
    }
    const parsed = parseTransportListXml(body);
    if (parsed.length > 0) return parsed;
    // Fallback: try the legacy shape via abap-adt-api in case we are on NPL
    // 7.50 where the flat <request> schema doesn't apply.
    try {
      const tu = await this.inner.userTransports(effectiveUser, true);
      const out: TransportSummary[] = [];
      const collect = (targets: typeof tu.workbench, workbench: boolean): void => {
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
    } catch {
      // Both shapes empty — return [] (caller can decide what to do).
      return [];
    }
  }

  /**
   * Detail of a single transport request: tasks, owner per task, and the
   * objects each task contains.
   *
   * Like listTransports, this bypasses abap-adt-api's transportDetails()
   * because that helper parses the legacy `<tm:root><tm:request>` schema
   * that S/4HANA doesn't emit. The flat `<request>` schema we get on S/4
   * holds task children inline.
   */
  async transportContents(transportNumber: string): Promise<TransportContents> {
    await this.connect();
    const url = `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`;
    let body: string;
    try {
      const resp = await rawAdtGet(this.inner, url, {
        Accept: 'application/vnd.sap.adt.transportorganizer.v1+xml',
      });
      body = resp.body;
    } catch (err) {
      throw wrapAdtError(err, `transportContents(${transportNumber})`);
    }
    const parsed = parseTransportDetailsXml(body, transportNumber);
    if (parsed) return parsed;
    // Fallback to the legacy helper for sandbox NPL.
    const legacy = (
      this.inner as unknown as {
        transportDetails: (n: string) => Promise<{
          'tm:number': string;
          'tm:owner': string;
          'tm:desc': string;
          'tm:status': string;
          objects?: TransportRawObject[];
          tasks?: TransportRawTask[];
        }>;
      }
    ).transportDetails;
    if (typeof legacy !== 'function') {
      throw new Error(
        `transportContents(${transportNumber}): server returned no parseable detail XML and abap-adt-api's transportDetails is not available.`,
      );
    }
    let detail: Awaited<ReturnType<typeof legacy>>;
    try {
      detail = await legacy.call(this.inner, transportNumber);
    } catch (err) {
      throw wrapAdtError(err, `transportContents(${transportNumber}) [legacy]`);
    }
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

/**
 * Construct the underlying abap-adt-api ADTClient honoring the auth mode.
 *
 *   - 'basic' (default): url/user/password, as before.
 *   - 'bearer': abap-adt-api accepts a BearerFetcher in the password slot and
 *     manages the Authorization header + token refresh itself. User is passed
 *     through (some flows still reference it) but auth is the token.
 *   - 'cookie': no password; the Cookie header is injected via ClientOptions.
 *     The server treats the session cookie as the credential (SSO).
 *
 * Centralized so the constructor and recycleSession() build identical clients.
 */
function buildInner(opts: AdtConnectionOptions): ADTClient {
  const mode = opts.authMode ?? 'basic';
  if (mode === 'bearer') {
    if (!opts.bearerToken) {
      throw new Error('authMode "bearer" requires a bearerToken function.');
    }
    // The 3rd positional arg accepts `string | BearerFetcher` in abap-adt-api.
    return new ADTClient(
      opts.url,
      opts.user,
      opts.bearerToken as unknown as string,
      opts.client,
      opts.language,
    );
  }
  if (mode === 'cookie') {
    if (!opts.cookie) {
      throw new Error('authMode "cookie" requires a cookie string.');
    }
    // abap-adt-api rejects an empty password at construction, so we pass a
    // non-empty placeholder. It is never used for auth: our explicit Cookie
    // header takes precedence (AdtHTTP only falls back to its own cookie jar
    // when no Cookie header is present), and the SAP session cookie is the
    // real credential. The placeholder just satisfies the constructor guard.
    return new ADTClient(opts.url, opts.user, 'cookie-auth', opts.client, opts.language, {
      headers: { Cookie: opts.cookie },
    } as unknown as ConstructorParameters<typeof ADTClient>[5]);
  }
  // basic (or service-key, not yet implemented — falls back to basic shape)
  return new ADTClient(opts.url, opts.user, opts.password, opts.client, opts.language);
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
    description: decodeXmlEntities(r['adtcore:description']),
  };
}

/**
 * Decode the small set of HTML/XML entities that show up in ADT search and
 * package-list descriptions. ADT serves XML that the XML parser then leaves
 * partially-encoded — we see `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`,
 * and numeric refs like `&#39;`. ARC-1 hit and fixed the same bug in #243.
 *
 * Returns the original input untouched when no entities are present
 * (cheap fast-path).
 */
export function decodeXmlEntities(input: string | undefined): string | undefined {
  if (!input) return input;
  if (!input.includes('&')) return input;
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
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

/**
 * POST a raw XML body to an ADT URL, reusing abap-adt-api's session.
 *
 * Why this helper exists: abap-adt-api exposes `httpClient.request(url, opts)`
 * but the types for `opts` are loose. We narrow them here so callers don't
 * have to remember the right field names, and to keep the cast to `unknown`
 * isolated to one place.
 *
 * Throws on non-2xx via the underlying axios pipeline — the AdtException
 * type bubbles up with `statusCode` and `body`.
 */
async function rawAdtPost(
  inner: ADTClient,
  url: string,
  body: string,
  contentType: string,
): Promise<{ status: number; body: string }> {
  const http = (
    inner as unknown as {
      httpClient: {
        request: (
          url: string,
          opts: {
            method?: string;
            body?: string;
            headers?: Record<string, string>;
          },
        ) => Promise<{ status: number; body: string }>;
      };
    }
  ).httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new Error(
      'abap-adt-api: ADTClient.httpClient.request not available. Upgrade the library or fall back to createObject().',
    );
  }
  const resp = await http.request(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': contentType },
  });
  return { status: resp.status, body: resp.body };
}

/**
 * GET a raw ADT URL with an explicit Accept header, reusing abap-adt-api's
 * session. Mirror of rawAdtPost for endpoints where we need a different
 * MIME type than the lib's defaults (e.g. the CTS transportorganizertree
 * vendor type for /cts/transportrequests).
 */
/**
 * POST with a vendor Content-Type AND a custom Accept header.
 * The basic rawAdtPost doesn't let callers set Accept; this variant does.
 */
async function rawAdtPostWithAccept(
  inner: ADTClient,
  url: string,
  body: string,
  contentType: string,
  accept: string,
): Promise<{ status: number; body: string }> {
  const http = (
    inner as unknown as {
      httpClient: {
        request: (
          url: string,
          opts: { method?: string; body?: string; headers?: Record<string, string> },
        ) => Promise<{ status: number; body: string }>;
      };
    }
  ).httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new Error('abap-adt-api: ADTClient.httpClient.request not available.');
  }
  const resp = await http.request(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': contentType, Accept: accept },
  });
  return { status: resp.status, body: resp.body };
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function rawAdtGet(
  inner: ADTClient,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const http = (
    inner as unknown as {
      httpClient: {
        request: (
          url: string,
          opts: { method?: string; headers?: Record<string, string> },
        ) => Promise<{ status: number; body: string }>;
      };
    }
  ).httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new Error('abap-adt-api: ADTClient.httpClient.request not available.');
  }
  const resp = await http.request(url, { method: 'GET', headers });
  return { status: resp.status, body: resp.body };
}

/**
 * Parse the flat `<request>` XML shape that S/4HANA returns from
 * /sap/bc/adt/cts/transportrequests. Robust to attribute prefixes and
 * tolerant of missing fields (treats them as empty strings).
 *
 * Tasks (subrequests, "Aufgaben") are nested as `<task>` children inside
 * each `<request>`. We aggregate them under a single TransportSummary per
 * request because the MCP-layer ListTransports tool exposes only the
 * request level — task detail goes through transportContents() instead.
 */
function parseTransportListXml(xml: string): TransportSummary[] {
  if (!xml || xml.trim() === '') return [];
  const out: TransportSummary[] = [];
  // Tolerant regex parser — we don't need a full XML AST and fast-xml-parser
  // isn't a dep of this package. Match each <request ...> ... </request> block.
  const requestRe = /<request\b([^>]*)>([\s\S]*?)<\/request>/g;
  let m: RegExpExecArray | null;
  while ((m = requestRe.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const number = attr(attrs, 'number');
    if (!number) continue;
    const status = attr(attrs, 'status'); // 'D' = modifiable, 'R' = released
    const type = attr(attrs, 'type'); // 'K' workbench, 'W' customizing, 'T' transport-of-copies
    out.push({
      number,
      owner: attr(attrs, 'owner'),
      description: attr(attrs, 'desc'),
      status,
      state: status === 'R' ? 'released' : 'modifiable',
      targetName: attr(attrs, 'target') || undefined,
      workbench: type !== 'W', // 'K' and 'T' count as workbench; 'W' is customizing
      objectCount: countAbapObjects(inner),
    });
  }
  return out;
}

function attr(attrString: string, name: string): string {
  const re = new RegExp(`\\b${name}="([^"]*)"`);
  const m = attrString.match(re);
  return m?.[1] ?? '';
}

/**
 * Parse the `nodestructure` response into DEVC/K child package names.
 *
 * The body is an asx:abap envelope with `<SEU_ADT_REPOSITORY_OBJ_NODE>` rows,
 * each carrying `<OBJECT_TYPE>` and `<OBJECT_NAME>`. We keep only `DEVC/K`
 * (real packages — not `DEVC/KI` package interfaces or other node types),
 * uppercase + dedupe. Tolerant regex parser (no XML AST dep), mirroring the
 * other parsers in this file. Empty body → no children.
 */
function parseSubpackageNames(xml: string): string[] {
  if (!xml || xml.trim() === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const nodeRe = /<SEU_ADT_REPOSITORY_OBJ_NODE\b[^>]*>([\s\S]*?)<\/SEU_ADT_REPOSITORY_OBJ_NODE>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const block = m[1];
    const type = innerText(block, 'OBJECT_TYPE');
    if (type !== 'DEVC/K') continue;
    const name = innerText(block, 'OBJECT_NAME').trim().toUpperCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function countAbapObjects(blockXml: string): number {
  const matches = blockXml.match(/<abap_object\b/g);
  return matches?.length ?? 0;
}

/**
 * Parse the flat `<request>...<task>...</task></request>` shape returned by
 * GET /sap/bc/adt/cts/transportrequests/{number} on S/4HANA. Returns null
 * when the XML doesn't match (caller falls back to abap-adt-api's parser).
 *
 * Honors the requested transport number — if the returned XML happens to
 * contain a different `<request number="...">` (some NW 7.50 releases return
 * the caller's whole list when the id is unknown, instead of 404), we ignore
 * mismatches and return null so the caller can throw a sane error.
 */
function parseTransportDetailsXml(xml: string, expectedNumber: string): TransportContents | null {
  if (!xml) return null;
  const reqRe = /<request\b([^>]*)>([\s\S]*?)<\/request>/g;
  const taskRe = /<task\b([^>]*)>([\s\S]*?)<\/task>/g;
  const objRe = /<abap_object\b([^>]*)\/?>/g;

  let match: RegExpExecArray | null;
  while ((match = reqRe.exec(xml)) !== null) {
    const reqAttrs = match[1];
    const reqInner = match[2];
    const number = attr(reqAttrs, 'number');
    if (number !== expectedNumber) continue;

    const tasks: TransportContents['tasks'] = [];
    let tMatch: RegExpExecArray | null;
    const taskScanner = new RegExp(taskRe.source, taskRe.flags);
    while ((tMatch = taskScanner.exec(reqInner)) !== null) {
      const tAttrs = tMatch[1];
      const tInner = tMatch[2];
      const taskObjs: Array<{
        pgmid: string;
        type: string;
        name: string;
        info?: string;
      }> = [];
      let oMatch: RegExpExecArray | null;
      const objScanner = new RegExp(objRe.source, objRe.flags);
      while ((oMatch = objScanner.exec(tInner)) !== null) {
        const oAttrs = oMatch[1];
        taskObjs.push({
          pgmid: attr(oAttrs, 'pgmid'),
          type: attr(oAttrs, 'type'),
          name: attr(oAttrs, 'name'),
          info: attr(oAttrs, 'obj_desc') || attr(oAttrs, 'obj_info') || undefined,
        });
      }
      tasks.push({
        number: attr(tAttrs, 'number'),
        owner: attr(tAttrs, 'owner'),
        description: attr(tAttrs, 'desc'),
        status: attr(tAttrs, 'status'),
        objects: taskObjs,
      });
    }

    // Top-level <abap_object> tags directly under <request> (objects assigned
    // to the request itself, not a task). Re-scan reqInner skipping <task> blocks.
    const reqOnlyInner = reqInner.replace(/<task\b[\s\S]*?<\/task>/g, '');
    const ownObjects: Array<{
      pgmid: string;
      type: string;
      name: string;
      info?: string;
    }> = [];
    let oMatch2: RegExpExecArray | null;
    const objScanner2 = new RegExp(objRe.source, objRe.flags);
    while ((oMatch2 = objScanner2.exec(reqOnlyInner)) !== null) {
      const oAttrs = oMatch2[1];
      ownObjects.push({
        pgmid: attr(oAttrs, 'pgmid'),
        type: attr(oAttrs, 'type'),
        name: attr(oAttrs, 'name'),
        info: attr(oAttrs, 'obj_desc') || attr(oAttrs, 'obj_info') || undefined,
      });
    }

    return {
      number,
      owner: attr(reqAttrs, 'owner'),
      description: attr(reqAttrs, 'desc'),
      status: attr(reqAttrs, 'status'),
      tasks,
      allObjects: [...ownObjects, ...tasks.flatMap((t) => t.objects)],
    };
  }
  return null;
}

/**
 * Parse the asx:abap response from /sap/bc/adt/cts/transportchecks.
 *
 * The body is a flat XML with `<DATA>` carrying:
 *   - `<DLVUNIT>` — delivery unit / software component
 *   - `<RECORDING>` — 'X' if a corrNr is required, '' otherwise
 *   - `<DEVCLASS>` — echo of the package
 *   - `<LOCKS>/<HEADER>/<TRKORR>` — TR holding the object if locked
 *   - `<TRANSPORTS>/<headers>/{TRKORR,AS4TEXT,AS4USER}` — candidate TRs
 *   - `<MESSAGES>/<MESSAGE>/{TEXT,TYPE}` — errors/warnings from the check
 *
 * Tolerant: missing fields default to empty/false. Messages with TYPE='E' or
 * 'A' go to errors[], 'W'/'I' go to warnings[].
 */
function parseTransportCheckXml(xml: string, devclass: string): TransportCheckResult {
  if (!xml) {
    return {
      recordingRequired: false,
      isLocal: isLocalPackage(devclass),
      deliveryUnit: '',
      devclass,
      candidateTransports: [],
      errors: ['empty response from transportchecks endpoint'],
      warnings: [],
    };
  }
  const recording = innerText(xml, 'RECORDING') === 'X';
  const dlvunit = innerText(xml, 'DLVUNIT');
  const echoDevclass = innerText(xml, 'DEVCLASS') || devclass;

  // Candidate transports: scan <headers> blocks under <TRANSPORTS>.
  const candidateTransports: TransportCheckResult['candidateTransports'] = [];
  const headersRe = /<headers\b[^>]*>([\s\S]*?)<\/headers>/g;
  let m: RegExpExecArray | null;
  while ((m = headersRe.exec(xml)) !== null) {
    const block = m[1];
    const number = innerText(block, 'TRKORR');
    if (!number) continue;
    candidateTransports.push({
      number,
      description: innerText(block, 'AS4TEXT'),
      owner: innerText(block, 'AS4USER'),
    });
  }

  // Locked transport: <LOCKS><HEADER><TRKORR>
  let lockedInTransport: string | undefined;
  const locksMatch = xml.match(/<LOCKS\b[^>]*>([\s\S]*?)<\/LOCKS>/);
  if (locksMatch) {
    const headerMatch = locksMatch[1].match(/<HEADER\b[^>]*>([\s\S]*?)<\/HEADER>/);
    if (headerMatch) {
      const trkorr = innerText(headerMatch[1], 'TRKORR');
      if (trkorr) lockedInTransport = trkorr;
    }
  }

  // Messages: scan <MESSAGE> blocks, classify by TYPE.
  const errors: string[] = [];
  const warnings: string[] = [];
  const msgRe = /<MESSAGE\b[^>]*>([\s\S]*?)<\/MESSAGE>/g;
  while ((m = msgRe.exec(xml)) !== null) {
    const block = m[1];
    const type = innerText(block, 'TYPE');
    const text = innerText(block, 'TEXT') || innerText(block, 'SHORT_TEXT');
    if (!text) continue;
    if (type === 'E' || type === 'A' || type === 'X') {
      errors.push(text);
    } else {
      warnings.push(text);
    }
  }

  return {
    recordingRequired: recording,
    isLocal: dlvunit === 'LOCAL' || isLocalPackage(echoDevclass),
    deliveryUnit: dlvunit,
    devclass: echoDevclass,
    candidateTransports,
    lockedInTransport,
    errors,
    warnings,
  };
}

/** Extract text content of the first occurrence of <tag>...</tag> in xml. */
function innerText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  if (!m) return '';
  return m[1].trim();
}

/**
 * Build the ADT URL for a class section (main or one of the local-types
 * includes CCDEF/CCIMP/macros/testclasses).
 *
 *   classObjectUri = /sap/bc/adt/oo/classes/zcl_x
 *   main           → /sap/bc/adt/oo/classes/zcl_x/source/main
 *   definitions    → /sap/bc/adt/oo/classes/zcl_x/includes/definitions
 *   implementations→ /sap/bc/adt/oo/classes/zcl_x/includes/implementations
 *   testclasses    → /sap/bc/adt/oo/classes/zcl_x/includes/testclasses
 *   macros         → /sap/bc/adt/oo/classes/zcl_x/includes/macros
 *
 * IMPORTANT: includes do NOT take a trailing `/source/main` segment on S/4HANA.
 * That suffix is only valid for the `main` source. Verified against ARC-1's
 * `rap-generate.ts:classIncludeUrlFor` and live <abapsource:sourceUri> values
 * in the ADT `objectStructure` response for a behavior pool class on PCE.
 * Earlier versions of this helper appended `/source/main` to includes too,
 * which made PUTs 404 on S/4 (the resource exists at the shorter path).
 */
function buildClassIncludeUri(
  classObjectUri: string,
  include: 'main' | 'definitions' | 'implementations' | 'macros' | 'testclasses',
): string {
  const clean = classObjectUri.replace(/\/+$/, '');
  if (include === 'main') return `${clean}/source/main`;
  return `${clean}/includes/${include}`;
}

/**
 * Parse the asx:abap response from the publish/unpublish service-binding POST.
 *
 * Body shape captured live on PCE 2026-05-31 (verified with raw curl by the
 * other Claude session — see conversation history):
 *
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">
 *     <asx:values>
 *       <DATA>
 *         <SEVERITY>OK</SEVERITY>
 *         <SHORT_TEXT>Local Service Endpoint of service X with version Y is activated locally</SHORT_TEXT>
 *         <LONG_TEXT/>
 *       </DATA>
 *     </asx:values>
 *   </asx:abap>
 *
 * Note: SEVERITY in this endpoint is literal "OK" / probably "ERROR" — NOT
 * the T100 single-letter codes (S/I/W/E/A/X) that ABAP uses elsewhere.
 * Callers map success at their layer (`isPublishSuccess` in dev-mcp).
 *
 * We use a tolerant regex instead of pulling in fast-xml-parser as a dep
 * (the asx envelope is fully predictable). Missing fields return empty
 * strings, NOT a fabricated sentinel — earlier code invented `severity='?'`
 * for non-standard bodies, which lied to the caller. If the body doesn't
 * parse, return the raw preview in longText and let the caller decide.
 */
function parsePublishResponse(xml: string): {
  severity: string;
  shortText: string;
  longText: string;
} {
  const severity = (xml.match(/<SEVERITY>([^<]*)<\/SEVERITY>/i)?.[1] ?? '').trim();
  const shortText = (xml.match(/<SHORT_TEXT>([\s\S]*?)<\/SHORT_TEXT>/i)?.[1] ?? '').trim();
  const longText = (xml.match(/<LONG_TEXT>([\s\S]*?)<\/LONG_TEXT>/i)?.[1] ?? '').trim();
  if (severity || shortText) {
    return { severity, shortText, longText };
  }
  // Body didn't contain the expected envelope. Don't fabricate severity —
  // surface the first 400 chars of the actual response so the caller can
  // diagnose (CSRF rejection, HTML error page, plain-text "Forbidden", etc.).
  const preview = xml.replace(/\s+/g, ' ').trim().slice(0, 400);
  return {
    severity: '',
    shortText: '',
    longText: preview,
  };
}

/**
 * Build the URL for a raw-create POST (BDEF / SRVB collection endpoints).
 *
 * Both endpoints require `_package=<PKG>` as a query parameter. Transportable
 * packages ALSO require `corrNr=<TR>` — without it the ADT rejects the POST
 * with HTTP 400 `SADT_RESOURCE-17 "Parameter corrNr could not be found"`.
 * Local packages ($*) must NOT receive a corrNr; the ADT rejects those too.
 *
 * Centralized here so createBdefRaw and createSrvbRaw share the same logic
 * (and so future raw create endpoints can reuse it).
 */
function buildRawCreateUrl(
  collectionUrl: string,
  packageName: string,
  transport: string | undefined,
): string {
  const params = new URLSearchParams({ _package: packageName.toUpperCase() });
  // Local packages reject any corrNr; transportable ones require it. The
  // isLocalPackage helper protects us from accidentally appending a stale
  // transport string against $TMP & co.
  if (transport?.trim() && !isLocalPackage(packageName)) {
    params.set('corrNr', transport.trim());
  }
  return `${collectionUrl}?${params.toString()}`;
}

/**
 * `$TMP` and any `$*` package are local — they do NOT participate in
 * transports. Passing a corrNr against them makes ADT return 400. Detect
 * this so callers can ship `transport` blindly without us crashing.
 *
 * Exported so MCP-layer code can apply the same rule before constructing
 * request payloads.
 */
export function isLocalPackage(packageName: string | undefined): boolean {
  if (!packageName) return false;
  return packageName.trim().startsWith('$');
}

/**
 * Re-throw an error with the structured ADT detail surfaced into the message.
 *
 * abap-adt-api's `AdtErrorException.message` is just "Request failed with
 * status code 400" — the actual SAP reason ("Resource CLAS ZCL_X does already
 * exist (ExceptionResourceAlreadyExists)") lives in `localizedMessage` and
 * `type`/`properties`. We funnel every thrown error through here so the MCP
 * caller actually sees why SAP rejected the call. The original error is
 * preserved as `.cause` so middleware (idempotency checks, logging) can still
 * inspect the structured fields.
 */
function wrapAdtError(err: unknown, opLabel: string): Error {
  if (!err) return new Error(`[${opLabel}] unknown error`);
  // If it's already wrapped (CapituAdtError), bubble through.
  if (err instanceof CapituAdtError) return err;
  const detail = inspectAdtError(err);
  const summary = describeAdtError(err);
  return new CapituAdtError(`[${opLabel}] ${summary}`, detail, err);
}

/**
 * Error subclass that carries the structured ADT detail. Callers can do
 * `if (e instanceof CapituAdtError) { … e.detail.exceptionType … }` to make
 * idempotency or retry decisions without re-parsing strings.
 */
export class CapituAdtError extends Error {
  readonly detail: ReturnType<typeof inspectAdtError>;
  override readonly cause: unknown;
  constructor(message: string, detail: ReturnType<typeof inspectAdtError>, cause: unknown) {
    super(message);
    this.name = 'CapituAdtError';
    this.detail = detail;
    this.cause = cause;
  }
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
    description: decodeXmlEntities(r.DESCRIPTION),
  };
}
