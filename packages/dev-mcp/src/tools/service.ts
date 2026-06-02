/**
 * Service Definition (SRVD) + Service Binding (SRVB) tools.
 *
 * Why these live in dev-mcp (not just spec-mcp): completing the RAP stack from
 * a chat workflow needs single-shot tools that create + write + activate the
 * service objects without going through the proposal lifecycle. spec-mcp is
 * still the right tool for designed stacks; dev-mcp covers the imperative path.
 *
 * Coverage:
 *
 *   - capituDevCreateServiceDefinition — create SRVD, write source (auto-generated
 *     skeleton or caller-provided), activate. Uses abap-adt-api createObject for
 *     SRVD (it IS in the CreatableTypeIds union).
 *
 *   - capituDevCreateServiceBinding   — create SRVB via createSrvbRaw (the raw
 *     ADT POST path; abap-adt-api does NOT include SRVB/SVB in CreatableTypeIds).
 *     Activates after create.
 *
 *   - capituDevPublishServiceBinding   — call /sap/bc/adt/businessservices/odatav4/publishjobs
 *     to publish the bound OData service to the SICF tree. Equivalent of the
 *     "Publish Local Service Endpoint" button in Eclipse's SRVB editor.
 */

import { isLocalPackage } from '@capitu/adt-client';
import { z } from 'zod';
import { type ServerContext, assertWritesEnabled } from '../context.js';
import type { CapituTool } from '../tool.js';

/**
 * Severity codes that mean "the SAP accepted the request".
 *
 * The publishjobs/unpublishjobs endpoint in S/4HANA PCE returns `SEVERITY="OK"`
 * (literal string, not a T100 letter). Captured live 2026-05-31:
 *
 *   <DATA><SEVERITY>OK</SEVERITY><SHORT_TEXT>Local Service Endpoint of
 *   service ZUI_PURCHASE_REQ_O4 with version 0001 is activated locally
 *   </SHORT_TEXT><LONG_TEXT/></DATA>
 *
 * Standard T100 severities ('S'=success, 'I'=info) are also treated as
 * success in case other releases use the canonical letters. 'W' (warning)
 * is NOT treated as failure — warning means published, but with something
 * worth surfacing.
 */
const SUCCESS_SEVERITIES = new Set(['OK', 'S', 'I', 'W']);

function isPublishSuccess(severity: string): boolean {
  return SUCCESS_SEVERITIES.has(severity.toUpperCase());
}

// Write gate shared from context.ts (assertWritesEnabled). No local copy.

async function effectiveTransport(
  ctx: ServerContext,
  packageName: string,
  transport: string | undefined,
): Promise<string | undefined> {
  if (isLocalPackage(packageName)) return undefined;
  if (transport?.trim()) return transport.trim();
  return ctx.adt.pickDefaultTransport(packageName);
}

// ─── 1. capituDevCreateServiceDefinition (SRVD) ─────────────────────────────

const createServiceDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(30)
    .describe(
      'SRVD name (uppercase by convention, e.g. ZUI_PURCHASE_REQ). Lowercased for the URI.',
    ),
  description: z.string().min(1).max(60).describe('Short description (max 60 chars).'),
  packageName: z
    .string()
    .min(1)
    .describe('Target package. Validated against CAPITU_ALLOWED_PACKAGES.'),
  exposedCdsView: z
    .string()
    .min(1)
    .describe(
      'CDS projection view exposed by this service definition (e.g. ZC_PURCHASE_REQ). The skeleton wraps it in `expose <view> as <alias>;`.',
    ),
  alias: z
    .string()
    .optional()
    .describe(
      'Optional OData alias for the exposed entity. Defaults to the CDS view name without leading Z*/Y* prefix.',
    ),
  source: z
    .string()
    .optional()
    .describe(
      'Optional full SRVD source. When omitted, a 1-entity skeleton is generated from exposedCdsView + alias.',
    ),
  transport: z
    .string()
    .optional()
    .describe('Optional transport request. Omit for $TMP / auto-pick.'),
  activate: z.boolean().default(true).describe('Activate after writing. Default true.'),
});

export interface CreateServiceDefinitionOutput {
  created: boolean;
  activated: boolean;
  name: string;
  objectUri: string;
  sourceUri: string;
  alias: string;
  generatedSkeleton: boolean;
  activationMessages: Array<{ type: string; text: string; line?: number }>;
  hint: string;
}

function defaultAlias(exposedCdsView: string): string {
  // Strip Z/Y prefix + common "I_"/"C_" intermediate, then PascalCase.
  // ZC_PURCHASE_REQ → PurchaseReq
  const raw = exposedCdsView.toUpperCase().replace(/^[ZY](?:[IC])?_?/, '');
  return raw
    .split('_')
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0) + s.slice(1).toLowerCase())
    .join('');
}

function buildSrvdSource(name: string, alias: string, exposedCdsView: string): string {
  return `@EndUserText.label: '${name}'
define service ${name} {
  expose ${exposedCdsView} as ${alias};
}
`;
}

export const createServiceDefinitionTool: CapituTool<
  typeof createServiceDefinitionSchema,
  CreateServiceDefinitionOutput
> = {
  name: 'capituDevCreateServiceDefinition',
  description:
    'Create + write + activate a Service Definition (SRVD) in one call. SRVD declares which CDS ' +
    'projection views are exposed via OData. When `source` is omitted, generates a minimal ' +
    '1-entity skeleton from `exposedCdsView` and `alias`. Next step after this is usually ' +
    'capituDevCreateServiceBinding pointing at this SRVD.',
  category: 'code-write',
  inputSchema: createServiceDefinitionSchema,
  handler: async (input, ctx): Promise<CreateServiceDefinitionOutput> => {
    assertWritesEnabled(ctx, input.packageName);
    const alias = input.alias?.trim() || defaultAlias(input.exposedCdsView);
    const source = input.source ?? buildSrvdSource(input.name, alias, input.exposedCdsView);
    const transport = await effectiveTransport(ctx, input.packageName, input.transport);
    const lowerName = input.name.toLowerCase();
    const objectUri = `/sap/bc/adt/ddic/srvd/sources/${lowerName}`;
    const sourceUri = `${objectUri}/source/main`;

    // Step 1: create (abap-adt-api accepts SRVD/SRV)
    await ctx.adt.createObject({
      objectType: 'SRVD/SRV',
      name: input.name,
      description: input.description,
      packageName: input.packageName,
      transport,
    });

    // Step 2: write source with lock
    const lock = await ctx.adt.lock(objectUri);
    try {
      await ctx.adt.writeSource(sourceUri, source, lock.lockHandle, transport);
    } finally {
      try {
        await ctx.adt.unlock(objectUri, lock.lockHandle);
      } catch {
        // best-effort
      }
    }

    let activated = false;
    const activationMessages: CreateServiceDefinitionOutput['activationMessages'] = [];
    if (input.activate) {
      const r = await ctx.adt.activate(input.name, objectUri);
      activated = r.success;
      for (const m of r.messages) {
        activationMessages.push({ type: m.type, text: m.text, line: m.line });
      }
    }

    return {
      created: true,
      activated,
      name: input.name.toUpperCase(),
      objectUri,
      sourceUri,
      alias,
      generatedSkeleton: input.source === undefined,
      activationMessages,
      hint: activated
        ? `SRVD active. Next: call capituDevCreateServiceBinding with serviceDefinition="${input.name.toUpperCase()}" and pick bindingType (e.g. ODataV4-UI).`
        : 'SRVD created but activation incomplete — review activationMessages and fix the CDS projection if needed.',
    };
  },
};

// ─── 2. capituDevCreateServiceBinding (SRVB) ────────────────────────────────

const createServiceBindingSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(30)
    .describe('SRVB name (uppercase by convention, e.g. ZUI_PURCHASE_REQ_O4).'),
  description: z.string().min(1).max(60).describe('Short description.'),
  packageName: z
    .string()
    .min(1)
    .describe('Target package. Validated against CAPITU_ALLOWED_PACKAGES.'),
  serviceDefinition: z
    .string()
    .min(1)
    .describe('SRVD name this binding exposes (the SRVD must be active already).'),
  bindingType: z
    .string()
    .default('ODataV4-UI')
    .describe(
      'LLM-friendly binding label. Examples: "ODataV4-UI" (default), "OData V4 Web API", "ODataV2-UI". Normalized internally to ADT type+version+category.',
    ),
  category: z
    .enum(['0', '1'])
    .optional()
    .describe(
      'Optional explicit category override: "0"=UI, "1"=Web API. Wins over bindingType hint.',
    ),
  odataVersion: z
    .enum(['V2', 'V4'])
    .optional()
    .describe('Optional explicit OData version override: V2 / V4. Wins over bindingType hint.'),
  version: z.string().optional().describe('Service version number. Default "0001".'),
  transport: z
    .string()
    .optional()
    .describe('Optional transport request. Omit for $TMP / auto-pick.'),
  activate: z
    .boolean()
    .default(true)
    .describe(
      'Activate after creating. Default true. SRVB has no source step — XML envelope is canonical.',
    ),
});

export interface CreateServiceBindingOutput {
  created: boolean;
  activated: boolean;
  name: string;
  objectUri: string;
  serviceDefinition: string;
  effectiveBinding: {
    type: 'ODATA';
    version: string;
    category: '0' | '1';
  };
  activationMessages: Array<{ type: string; text: string; line?: number }>;
  hint: string;
}

export const createServiceBindingTool: CapituTool<
  typeof createServiceBindingSchema,
  CreateServiceBindingOutput
> = {
  name: 'capituDevCreateServiceBinding',
  description:
    'Create + activate a Service Binding (SRVB) that exposes a Service Definition as OData. ' +
    'Uses raw ADT XML POST under the hood because abap-adt-api does NOT expose SRVB/SVB in its ' +
    'CreatableTypeIds union — that gap is filled by adt-client.createSrvbRaw. After activation, ' +
    'use capituDevPublishServiceBinding to register the service in the SICF tree (makes the OData ' +
    'endpoint reachable).',
  category: 'code-write',
  inputSchema: createServiceBindingSchema,
  handler: async (input, ctx): Promise<CreateServiceBindingOutput> => {
    assertWritesEnabled(ctx, input.packageName);
    const transport = await effectiveTransport(ctx, input.packageName, input.transport);

    const created = await ctx.adt.createSrvbRaw({
      name: input.name,
      description: input.description,
      packageName: input.packageName,
      serviceDefinition: input.serviceDefinition,
      bindingType: input.bindingType,
      category: input.category,
      odataVersion: input.odataVersion,
      version: input.version,
      transport,
    });

    // Echo what the normalizer actually used. Mirror of normalizeSrvbBindingType
    // logic so the caller can confirm without parsing the XML.
    const normalized = (() => {
      const raw = input.bindingType
        .trim()
        .toUpperCase()
        .replace(/[\s_-]+/g, '');
      let v: 'V2' | 'V4' = 'V2';
      if (raw.includes('V4')) v = 'V4';
      else if (raw.includes('V2')) v = 'V2';
      let c: '0' | '1' | undefined;
      if (raw.includes('WEBAPI') || raw.includes('API')) c = '1';
      else if (raw.includes('UI')) c = '0';
      return {
        version: (input.odataVersion ?? v) as string,
        category: (input.category ?? c ?? '0') as '0' | '1',
      };
    })();

    let activated = false;
    const activationMessages: CreateServiceBindingOutput['activationMessages'] = [];
    if (input.activate) {
      // SRVB activation: pass objectUri as both name and uri target. The
      // ADT activator distinguishes service-binding by the URI prefix.
      const r = await ctx.adt.activate(input.name, created.objectUri);
      activated = r.success;
      for (const m of r.messages) {
        activationMessages.push({ type: m.type, text: m.text, line: m.line });
      }
    }
    return {
      created: true,
      activated,
      name: input.name.toUpperCase(),
      objectUri: created.objectUri,
      serviceDefinition: input.serviceDefinition.toUpperCase(),
      effectiveBinding: {
        type: 'ODATA',
        version: normalized.version,
        category: normalized.category,
      },
      activationMessages,
      hint: activated
        ? `SRVB active. To make the OData endpoint reachable, call capituDevPublishServiceBinding with name="${input.name.toUpperCase()}". Eclipse equivalent: "Publish Local Service Endpoint" button on the SRVB editor.`
        : 'SRVB created but activation incomplete — review activationMessages. Common cause: the SRVD is not active yet.',
    };
  },
};

// ─── 3. capituDevPublishServiceBinding (publish OData service) ──────────────

const publishServiceBindingSchema = z.object({
  name: z.string().min(1).max(30).describe('SRVB name to publish (must be active).'),
  version: z.string().optional().describe('Service version (default "0001").'),
});

export interface PublishServiceBindingOutput {
  ok: boolean;
  name: string;
  version: string;
  /** SAP severity code: 'S' success, 'I' info, 'W' warning, 'E' error, 'A' abort, 'X' exception. */
  severity: string;
  shortText: string;
  longText: string;
  /** Predicted OData base URL — convenience for the LLM. */
  predictedEndpoint: string;
  message: string;
}

export const publishServiceBindingTool: CapituTool<
  typeof publishServiceBindingSchema,
  PublishServiceBindingOutput
> = {
  name: 'capituDevPublishServiceBinding',
  description:
    'Publish an active Service Binding so its OData endpoint becomes reachable. Equivalent of the ' +
    '"Publish Local Service Endpoint" button in Eclipse. Idempotent: re-publishing an active binding ' +
    'returns severity="S" with a no-op shortText on most releases. Requires the SRVB to be active ' +
    '(capituDevCreateServiceBinding activates by default). Uses abap-adt-api.publishServiceBinding ' +
    'under the hood — the endpoint path is /sap/bc/adt/businessservices/odatav2/publishjobs even for ' +
    'V4 bindings (single SAP endpoint covers both versions).',
  category: 'code-write',
  inputSchema: publishServiceBindingSchema,
  handler: async (input, ctx): Promise<PublishServiceBindingOutput> => {
    const version = input.version?.trim() || '0001';
    const result = await ctx.adt.publishServiceBinding(input.name, version);
    // Severity 'S' (success) and 'I' (info) both mean the request was accepted.
    // 'W' is also non-fatal but worth flagging in the message.
    const ok = isPublishSuccess(result.severity);
    const lower = input.name.toLowerCase();
    const predictedEndpoint = `/sap/opu/odata4/sap/${lower}/srvd_a2x/sap/${lower}/${version}/`;
    return {
      ok,
      name: input.name.toUpperCase(),
      version,
      severity: result.severity,
      shortText: result.shortText,
      longText: result.longText,
      predictedEndpoint,
      message: ok
        ? `Published. OData endpoint reachable at ${predictedEndpoint} (test with HTTP GET against $metadata). ${result.shortText || ''}`.trim()
        : `Publish failed [severity=${result.severity}]: ${result.shortText}. ${result.longText || ''}`.trim(),
    };
  },
};

// ─── 4. capituDevUnpublishServiceBinding (reverse of publish) ───────────────

const unpublishServiceBindingSchema = z.object({
  name: z.string().min(1).max(30).describe('SRVB name to unpublish.'),
  version: z.string().optional().describe('Service version (default "0001").'),
});

export interface UnpublishServiceBindingOutput {
  ok: boolean;
  name: string;
  version: string;
  severity: string;
  shortText: string;
  longText: string;
  message: string;
}

export const unpublishServiceBindingTool: CapituTool<
  typeof unpublishServiceBindingSchema,
  UnpublishServiceBindingOutput
> = {
  name: 'capituDevUnpublishServiceBinding',
  description:
    'Reverse of capituDevPublishServiceBinding — removes the SICF registration so the OData endpoint ' +
    'stops responding. The SRVB stays active in TADIR; only the runtime route is removed. Use before ' +
    'deleting an SRVB or when iterating on a binding configuration.',
  category: 'code-write',
  inputSchema: unpublishServiceBindingSchema,
  handler: async (input, ctx): Promise<UnpublishServiceBindingOutput> => {
    const version = input.version?.trim() || '0001';
    const result = await ctx.adt.unpublishServiceBinding(input.name, version);
    const ok = isPublishSuccess(result.severity);
    return {
      ok,
      name: input.name.toUpperCase(),
      version,
      severity: result.severity,
      shortText: result.shortText,
      longText: result.longText,
      message: ok
        ? `Unpublished. ${result.shortText || ''}`.trim()
        : `Unpublish failed [severity=${result.severity}]: ${result.shortText}. ${result.longText || ''}`.trim(),
    };
  },
};
