/**
 * Raw ADT object creation for types that abap-adt-api's createObject() does
 * not expose in its `CreatableTypeIds` union — currently BDEF (RAP behavior
 * definitions) and SRVB (service bindings).
 *
 * Why bypass abap-adt-api?
 *   - createObject() in abap-adt-api accepts only a fixed string-literal union
 *     of object types. BDEF/BDO and SRVB/SVB are missing — passing them as
 *     `objtype` is a TS error at compile time and silently fails (or returns
 *     a malformed payload) at runtime on some adt-api versions.
 *   - The ADT REST endpoints themselves are stable and well-known. ARC-1 and
 *     vibing-steampunk both hit them directly with hand-built XML.
 *
 * What we keep from abap-adt-api:
 *   - Session, cookies, CSRF token, stateful flag, login refresh.
 *   - We reach the underlying transport via `ADTClient.httpClient.request()`.
 *     That gives us the configured axios pipeline (TLS, auth, cookies) at no
 *     extra cost.
 *
 * Reference XML payloads were extracted from ARC-1's
 * `src/adt/ddic-xml.ts` (SRVB) and `src/handlers/intent.ts` BDEF case
 * (blue:blueSource framework). See README "RAP support" for the long story.
 */

export interface BdefCreateParams {
  /** BDEF name (e.g. 'ZI_BOOKING'). Will be uppercased per SAP convention. */
  name: string;
  description: string;
  /** Target package, e.g. '$TMP' or 'ZIVB_APRENDIZAGEM'. */
  packageName: string;
  /**
   * Optional transport request (corrNr). Required when the package is
   * transportable; omitted when the package is local (`$*`). The raw POST
   * appends this as a `corrNr` query parameter — without it, transportable
   * packages return HTTP 400 SADT_RESOURCE-17 "Parameter corrNr could not be found".
   */
  transport?: string;
}

export interface SrvbCreateParams {
  /** SRVB name (e.g. 'Z_UI_BOOKING'). Will be uppercased per SAP convention. */
  name: string;
  description: string;
  packageName: string;
  /** Service Definition (SRVD) name this binding exposes. */
  serviceDefinition: string;
  /**
   * LLM-friendly binding label, normalized internally. Examples:
   *   'ODataV4-UI', 'OData V4 Web API', 'ODATA_V2_UI'.
   * Defaults to ODataV2-UI when omitted.
   */
  bindingType?: string;
  /** '0' = UI, '1' = Web API. Overrides what bindingType implies. */
  category?: '0' | '1';
  /** OData protocol version: 'V2' or 'V4'. Overrides bindingType. */
  odataVersion?: string;
  /** Service version number (default '0001'). */
  version?: string;
  /**
   * Optional transport request (corrNr). Required when the package is
   * transportable; omitted when the package is local (`$*`). The raw POST
   * appends this as a `corrNr` query parameter — without it, transportable
   * packages return HTTP 400 SADT_RESOURCE-17 "Parameter corrNr could not be found".
   */
  transport?: string;
}

/** Content-type for BDEF source/metadata POST. Confirmed against PCE 7.57+. */
export const BDEF_CONTENT_TYPE = 'application/vnd.sap.adt.blues.v1+xml';

/** Content-type for SRVB metadata POST. */
export const SRVB_CONTENT_TYPE =
  'application/vnd.sap.adt.businessservices.servicebinding.v2+xml; charset=utf-8';

/** ADT collection endpoints (POST here to create). */
export const BDEF_COLLECTION = '/sap/bc/adt/bo/behaviordefinitions';
export const SRVB_COLLECTION = '/sap/bc/adt/businessservices/bindings';

/** Per-object source endpoint (POST/PUT with lock to update). */
export function bdefSourceUri(name: string): string {
  return `/sap/bc/adt/bo/behaviordefinitions/${encodeURIComponent(name.toLowerCase())}/source/main`;
}

export function bdefObjectUri(name: string): string {
  return `/sap/bc/adt/bo/behaviordefinitions/${encodeURIComponent(name.toLowerCase())}`;
}

export function srvbObjectUri(name: string): string {
  return `/sap/bc/adt/businessservices/bindings/${encodeURIComponent(name.toLowerCase())}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the create-payload XML for a BDEF (RAP behavior definition).
 *
 * The body uses SAP's "blue" framework (blue:blueSource with
 * http://www.sap.com/wbobj/blue namespace), the same way ARC-1, fr0ster
 * and vibing-steampunk do it. The XML carries only header metadata —
 * the actual `define behavior for …` source is uploaded afterwards via
 * a PUT to the source/main URL with a lock handle.
 */
export function buildBdefCreateXml(params: BdefCreateParams): string {
  const name = params.name.toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue"
                 xmlns:adtcore="http://www.sap.com/adt/core"
                 adtcore:description="${escapeXml(params.description)}"
                 adtcore:name="${escapeXml(name)}"
                 adtcore:type="BDEF/BDO"
                 adtcore:masterLanguage="EN"
                 adtcore:masterSystem="H00"
                 adtcore:responsible="DEVELOPER">
  <adtcore:packageRef adtcore:name="${escapeXml(params.packageName.toUpperCase())}"/>
</blue:blueSource>`;
}

/**
 * Normalize LLM-friendly binding strings (e.g. "ODataV4-UI") into the
 * srvb:type / srvb:version / srvb:category triple that ADT expects.
 *
 * Defaults: ODATA / V2 / undefined (caller fills 0=UI when no hint).
 */
export function normalizeSrvbBindingType(input?: string): {
  type: string;
  odataVersion: string;
  category?: '0' | '1';
} {
  if (!input?.trim()) return { type: 'ODATA', odataVersion: 'V2' };

  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '');

  let odataVersion = 'V2';
  if (normalized.includes('V4')) odataVersion = 'V4';
  else if (normalized.includes('V2')) odataVersion = 'V2';

  let category: '0' | '1' | undefined;
  if (normalized.includes('WEBAPI') || normalized.includes('API')) category = '1';
  else if (normalized.includes('UI')) category = '0';

  return { type: 'ODATA', odataVersion, category };
}

/**
 * Build the create-payload XML for a SRVB (service binding).
 *
 * Unlike BDEF, the SRVB is fully described by this single XML — there is
 * no separate "source" upload step. Activation is what makes the binding
 * usable.
 */
export function buildSrvbCreateXml(params: SrvbCreateParams): string {
  const normalized = normalizeSrvbBindingType(params.bindingType);
  const category = params.category ?? normalized.category ?? '0';
  const odataVersion = params.odataVersion?.trim().toUpperCase() || normalized.odataVersion;
  const serviceVersion = params.version?.trim() || '0001';
  const name = params.name.toUpperCase();
  const serviceDefinition = params.serviceDefinition.toUpperCase();

  return `<?xml version="1.0" encoding="UTF-8"?>
<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"
                     xmlns:adtcore="http://www.sap.com/adt/core"
                     adtcore:description="${escapeXml(params.description)}"
                     adtcore:name="${escapeXml(name)}"
                     adtcore:type="SRVB/SVB"
                     adtcore:language="EN"
                     adtcore:masterLanguage="EN"
                     adtcore:responsible="DEVELOPER">
  <adtcore:packageRef adtcore:name="${escapeXml(params.packageName.toUpperCase())}"/>
  <srvb:services srvb:name="${escapeXml(name)}">
    <srvb:content srvb:version="${escapeXml(serviceVersion)}">
      <srvb:serviceDefinition adtcore:name="${escapeXml(serviceDefinition)}"/>
    </srvb:content>
  </srvb:services>
  <srvb:binding srvb:category="${category}" srvb:type="${escapeXml(normalized.type)}" srvb:version="${escapeXml(odataVersion)}">
    <srvb:implementation adtcore:name=""/>
  </srvb:binding>
</srvb:serviceBinding>`;
}
