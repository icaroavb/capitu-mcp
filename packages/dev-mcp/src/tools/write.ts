import { type CapituAdtClient, isLocalPackage } from '@capitu/adt-client';
import { z } from 'zod';
import { type ServerContext, assertWritesEnabled } from '../context.js';
import type { CapituTool } from '../tool.js';

/**
 * Decide which transport to use for an operation against `packageName`:
 *
 *   - $TMP / any $* local package         → undefined (ADT rejects corrNr)
 *   - transportable + explicit transport  → that transport (after trim check)
 *   - transportable + no transport given  → auto-pick the user's first open
 *                                            workbench TR. Throws with an
 *                                            actionable message if zero.
 *
 * Centralized here so dev-mcp's three write tools all share the same rules,
 * and any future change to "what counts as a default TR" lives in one place.
 */
async function effectiveTransport(
  adt: CapituAdtClient,
  packageName: string,
  transport: string | undefined,
): Promise<string | undefined> {
  if (isLocalPackage(packageName)) return undefined;
  if (transport?.trim()) return transport.trim();
  return adt.pickDefaultTransport(packageName);
}

// Write safety gate (env ceiling ∩ active-instance profile) lives in context.ts
// as `assertWritesEnabled` — single source of truth shared by all write tools.

// ---- CreateObject -----------------------------------------------------------

const createObjectSchema = z.object({
  objectType: z
    .enum([
      'DDLS/DF', // CDS view (data definition)
      'CLAS/OC', // Global class
      'INTF/OI', // Global interface
      'DCLS/DL', // CDS access control
      'TABL/DT', // Database table (transparent)
      'DOMA/DD', // Domain
      'DTEL/DE', // Data element
      'SRVD/SRV', // Service Definition (RAP)
      'PROG/P', // Report
      'PROG/I', // Include
    ])
    .describe(
      'ADT type code. Most common: DDLS/DF (CDS view), CLAS/OC (class), INTF/OI (interface), DCLS/DL (access control), TABL/DT (table), SRVD/SRV (service definition). ' +
        'NOTE: BDEF/BDO (behavior definition) and SRVB/SVB (service binding) are NOT in this enum — they go through dedicated tools because abap-adt-api does not expose them in CreatableTypeIds. Use capituDevCreateServiceBinding for SRVB; for BDEF use capituSpecApply with kind:"behavior-definition".',
    ),
  name: z
    .string()
    .min(1)
    .max(30)
    .describe(
      'Object name (uppercase by convention, e.g. ZI_MY_VIEW). Will be lowercased for the URI.',
    ),
  description: z.string().min(1).max(60).describe('Short description (max 60 chars)'),
  packageName: z
    .string()
    .min(1)
    .describe('Target package. Validated against CAPITU_ALLOWED_PACKAGES.'),
  transport: z
    .string()
    .optional()
    .describe('Optional transport request. Omit for $TMP / local objects.'),
});

export interface CreateObjectOutput {
  created: boolean;
  objectType: string;
  name: string;
  uri: string;
  sourceUri: string;
  packageName: string;
  hint: string;
}

export const createObjectTool: CapituTool<typeof createObjectSchema, CreateObjectOutput> = {
  name: 'capituDevCreateObject',
  description:
    'Create a new ABAP/CDS object in a target package. After creation the object is INACTIVE and empty — ' +
    'next steps are: capituDevWriteObject with the actual source, then capituDevActivate. ' +
    'Requires CAPITU_ALLOW_WRITES=true and the package in CAPITU_ALLOWED_PACKAGES.',
  category: 'code-write',
  inputSchema: createObjectSchema,
  handler: async (input, ctx) => {
    assertWritesEnabled(ctx, input.packageName);
    const transport = await effectiveTransport(ctx.adt, input.packageName, input.transport);
    await ctx.adt.createObject({
      objectType: input.objectType,
      name: input.name,
      description: input.description,
      packageName: input.packageName,
      transport,
    });

    // Build the URIs that subsequent calls will need.
    const lowerName = input.name.toLowerCase();
    const uri = buildObjectUri(input.objectType, lowerName);
    const sourceUri = `${uri}/source/main`;

    return {
      created: true,
      objectType: input.objectType,
      name: input.name,
      uri,
      sourceUri,
      packageName: input.packageName,
      hint:
        'Object is INACTIVE and empty. Next: call capituDevWriteObject with sourceUri to add code, ' +
        'then capituDevActivate to make it usable.',
    };
  },
};

// ---- ApplyArtifact (macro: create + write + activate atomically) -----------

const applyArtifactSchema = z.object({
  objectType: z.enum([
    'DDLS/DF',
    'CLAS/OC',
    'INTF/OI',
    'DCLS/DL',
    'TABL/DT',
    'DOMA/DD',
    'DTEL/DE',
    'SRVD/SRV',
    'PROG/P',
    'PROG/I',
  ]),
  name: z.string().min(1).max(30),
  description: z.string().min(1).max(60),
  packageName: z.string().min(1),
  source: z.string().min(1).describe('Full ABAP/CDS source to be written after create'),
  transport: z.string().optional(),
  skipActivation: z
    .boolean()
    .default(false)
    .describe(
      'If true, performs create+write only and leaves the object inactive. Useful when a downstream object depends on this one and you want to activate them together.',
    ),
  skipSyntaxCheck: z.boolean().default(false),
});

export interface ApplyArtifactOutput {
  ok: boolean;
  name: string;
  uri: string;
  sourceUri: string;
  steps: Array<{
    step: 'create' | 'write' | 'activate';
    status: 'ok' | 'skipped' | 'error';
    detail?: string;
    durationMs: number;
  }>;
  failedAt?: 'create' | 'write' | 'activate';
  errorMessage?: string;
}

export const applyArtifactTool: CapituTool<typeof applyArtifactSchema, ApplyArtifactOutput> = {
  name: 'capituDevApplyArtifact',
  description:
    'Atomic macro: create + write + activate a single artifact in one call. ' +
    'Use this instead of calling create/write/activate separately. Stops at the first failed step ' +
    'and returns a structured log. Set skipActivation=true when a later artifact depends on this ' +
    'one and you want to activate them together. Requires CAPITU_ALLOW_WRITES=true and the package ' +
    'to be in CAPITU_ALLOWED_PACKAGES.',
  category: 'code-write',
  inputSchema: applyArtifactSchema,
  handler: async (input, ctx) => {
    assertWritesEnabled(ctx, input.packageName);

    const lowerName = input.name.toLowerCase();
    const uri = buildObjectUri(input.objectType, lowerName);
    const sourceUri = `${uri}/source/main`;
    const steps: ApplyArtifactOutput['steps'] = [];

    const transport = await effectiveTransport(ctx.adt, input.packageName, input.transport);

    // Step 1: create
    const t0 = Date.now();
    try {
      await ctx.adt.createObject({
        objectType: input.objectType,
        name: input.name,
        description: input.description,
        packageName: input.packageName,
        transport,
      });
      steps.push({ step: 'create', status: 'ok', durationMs: Date.now() - t0 });
    } catch (err) {
      steps.push({
        step: 'create',
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
      return {
        ok: false,
        name: input.name,
        uri,
        sourceUri,
        steps,
        failedAt: 'create',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 2: write (with optional pre-syntax check)
    const t1 = Date.now();
    try {
      if (!input.skipSyntaxCheck) {
        const fs = await ctx.adt.syntaxCheck(sourceUri, input.source);
        if (fs.some((f) => f.severity === 'error')) {
          const msg = fs
            .filter((f) => f.severity === 'error')
            .map((f) => `line ${f.line}: ${f.text}`)
            .join('; ');
          steps.push({
            step: 'write',
            status: 'error',
            detail: `pre-write syntax check failed: ${msg}`,
            durationMs: Date.now() - t1,
          });
          return {
            ok: false,
            name: input.name,
            uri,
            sourceUri,
            steps,
            failedAt: 'write',
            errorMessage: `syntax error before write: ${msg}`,
          };
        }
      }
      const lock = await ctx.adt.lock(uri);
      try {
        await ctx.adt.writeSource(sourceUri, input.source, lock.lockHandle, transport);
      } finally {
        try {
          await ctx.adt.unlock(uri, lock.lockHandle);
        } catch {
          // best-effort
        }
      }
      steps.push({ step: 'write', status: 'ok', durationMs: Date.now() - t1 });
    } catch (err) {
      steps.push({
        step: 'write',
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t1,
      });
      return {
        ok: false,
        name: input.name,
        uri,
        sourceUri,
        steps,
        failedAt: 'write',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 3: activate (optional)
    const t2 = Date.now();
    if (input.skipActivation) {
      steps.push({ step: 'activate', status: 'skipped', durationMs: 0 });
      return { ok: true, name: input.name, uri, sourceUri, steps };
    }
    try {
      const r = await ctx.adt.activate(input.name, uri);
      if (!r.success) {
        const msg = r.messages.map((m) => `${m.type}: ${m.text}`).join('; ');
        steps.push({
          step: 'activate',
          status: 'error',
          detail: msg || `${r.inactiveObjects} inactive objects remained`,
          durationMs: Date.now() - t2,
        });
        return {
          ok: false,
          name: input.name,
          uri,
          sourceUri,
          steps,
          failedAt: 'activate',
          errorMessage: msg || 'activation reported failure',
        };
      }
      steps.push({ step: 'activate', status: 'ok', durationMs: Date.now() - t2 });
    } catch (err) {
      steps.push({
        step: 'activate',
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t2,
      });
      return {
        ok: false,
        name: input.name,
        uri,
        sourceUri,
        steps,
        failedAt: 'activate',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    return { ok: true, name: input.name, uri, sourceUri, steps };
  },
};

function buildObjectUri(objectType: string, lowerName: string): string {
  switch (objectType) {
    case 'DDLS/DF':
      return `/sap/bc/adt/ddic/ddl/sources/${lowerName}`;
    case 'CLAS/OC':
      return `/sap/bc/adt/oo/classes/${lowerName}`;
    case 'INTF/OI':
      return `/sap/bc/adt/oo/interfaces/${lowerName}`;
    case 'DCLS/DL':
      return `/sap/bc/adt/acm/dcl/sources/${lowerName}`;
    case 'TABL/DT':
      return `/sap/bc/adt/ddic/tables/${lowerName}`;
    case 'DOMA/DD':
      return `/sap/bc/adt/ddic/domains/${lowerName}`;
    case 'DTEL/DE':
      return `/sap/bc/adt/ddic/dataelements/${lowerName}`;
    case 'SRVD/SRV':
      return `/sap/bc/adt/ddic/srvd/sources/${lowerName}`;
    case 'PROG/P':
      return `/sap/bc/adt/programs/programs/${lowerName}`;
    case 'PROG/I':
      return `/sap/bc/adt/programs/includes/${lowerName}`;
    default:
      return `/sap/bc/adt/${lowerName}`;
  }
}

// ---- SyntaxCheck ------------------------------------------------------------

const syntaxCheckSchema = z.object({
  uri: z.string().min(1).describe('ADT URI of the source (e.g. .../source/main).'),
  content: z
    .string()
    .optional()
    .describe(
      'Optional source content to check. If omitted, checks the current persisted source. ' +
        'Useful for previewing edits before writing.',
    ),
});

export interface SyntaxCheckOutput {
  ok: boolean;
  findings: Array<{
    severity: 'error' | 'warning' | 'info';
    line: number;
    offset: number;
    text: string;
  }>;
}

export const syntaxCheckTool: CapituTool<typeof syntaxCheckSchema, SyntaxCheckOutput> = {
  name: 'capituDevSyntaxCheck',
  description:
    'Run an ABAP/CDS syntax check via ADT. Returns severity-tagged findings. ' +
    'Use BEFORE writing/activating to validate proposed changes. Pass content=... to ' +
    'check a draft without persisting it.',
  category: 'code-check',
  inputSchema: syntaxCheckSchema,
  handler: async (input, ctx) => {
    const findings = await ctx.adt.syntaxCheck(input.uri, input.content);
    return {
      ok: findings.every((f) => f.severity !== 'error'),
      findings: findings.map((f) => ({
        severity: f.severity,
        line: f.line,
        offset: f.offset,
        text: f.text,
      })),
    };
  },
};

// ---- WriteObject ------------------------------------------------------------

const writeObjectSchema = z.object({
  sourceUri: z.string().min(1).describe('ADT source URI ending in /source/main.'),
  objectUri: z
    .string()
    .min(1)
    .describe('ADT object URI (without /source/main). Needed for locking.'),
  packageName: z
    .string()
    .min(1)
    .describe('Package the object belongs to. Validated against CAPITU_ALLOWED_PACKAGES.'),
  source: z.string().min(1).describe('New full source code to write.'),
  transport: z
    .string()
    .optional()
    .describe('Optional transport request number. Omit for $TMP objects.'),
  skipSyntaxCheck: z
    .boolean()
    .default(false)
    .describe('Skip the pre-write syntax check (NOT recommended).'),
});

export interface WriteObjectOutput {
  written: boolean;
  syntaxOk: boolean;
  syntaxFindings: Array<{ severity: string; line: number; text: string }>;
  lockReleased: boolean;
}

export const writeObjectTool: CapituTool<typeof writeObjectSchema, WriteObjectOutput> = {
  name: 'capituDevWriteObject',
  description:
    'Write source code to an ABAP/CDS object. Workflow: ' +
    '(1) acquire lock, (2) optional syntax check on the new source, ' +
    '(3) write, (4) release lock. The object remains INACTIVE until you call ' +
    'capituDevActivate. Requires CAPITU_ALLOW_WRITES=true and the package to be in ' +
    'CAPITU_ALLOWED_PACKAGES (default: $TMP only).',
  category: 'code-write',
  inputSchema: writeObjectSchema,
  handler: async (input, ctx) => {
    assertWritesEnabled(ctx, input.packageName);

    // Pre-write syntax check on the proposed content
    let syntaxFindings: SyntaxCheckOutput['findings'] = [];
    let syntaxOk = true;
    if (!input.skipSyntaxCheck) {
      const fs = await ctx.adt.syntaxCheck(input.sourceUri, input.source);
      syntaxFindings = fs.map((f) => ({
        severity: f.severity,
        line: f.line,
        offset: f.offset,
        text: f.text,
      }));
      syntaxOk = fs.every((f) => f.severity !== 'error');
      if (!syntaxOk) {
        return {
          written: false,
          syntaxOk: false,
          syntaxFindings,
          lockReleased: true, // we never acquired
        };
      }
    }

    const transport = await effectiveTransport(ctx.adt, input.packageName, input.transport);
    const lock = await ctx.adt.lock(input.objectUri);
    let written = false;
    let lockReleased = false;
    try {
      await ctx.adt.writeSource(input.sourceUri, input.source, lock.lockHandle, transport);
      written = true;
    } finally {
      // Always try to release the lock, even if write fails.
      try {
        await ctx.adt.unlock(input.objectUri, lock.lockHandle);
        lockReleased = true;
      } catch {
        // best-effort
      }
    }
    return { written, syntaxOk, syntaxFindings, lockReleased };
  },
};

// ---- WriteClassBundle (main + CCIMP under one lock) ------------------------

const writeClassBundleSchema = z.object({
  classObjectUri: z
    .string()
    .min(1)
    .describe(
      'ADT object URI of the class (NOT the source URI). Example: /sap/bc/adt/oo/classes/zbp_i_purchase_req',
    ),
  packageName: z
    .string()
    .min(1)
    .describe('Package the class belongs to. Validated against CAPITU_ALLOWED_PACKAGES.'),
  transport: z
    .string()
    .optional()
    .describe('Optional transport request number. Omit for $TMP objects.'),
  sources: z
    .array(
      z.object({
        include: z.enum(['main', 'definitions', 'implementations', 'macros', 'testclasses']),
        source: z.string().min(1),
      }),
    )
    .min(1)
    .max(5)
    .describe(
      'Ordered list of {include, source}. Main is always written first regardless of array order. ' +
        'Use "main" for the global class definition/implementation, "implementations" for the local ' +
        'handler class (lhc_*) in a RAP behavior pool. CCIMP and main MUST be written together for ' +
        'a fresh class — the include resource only materializes inside the same session that wrote main.',
    ),
  skipSyntaxCheck: z
    .boolean()
    .default(true)
    .describe(
      'Defaults to TRUE because the per-include syntax check endpoint behaves inconsistently for ' +
        'class sub-resources. Activation is the definitive validation for class bundles.',
    ),
});

export interface WriteClassBundleOutput {
  written: number;
  lockReleased: boolean;
  hint: string;
}

export const writeClassBundleTool: CapituTool<
  typeof writeClassBundleSchema,
  WriteClassBundleOutput
> = {
  name: 'capituDevWriteClassBundle',
  description:
    'Write multiple sources to a single class (main + class-local includes CCDEF/CCIMP/CCAU) ' +
    'under ONE lock in ONE stateful HTTP session. Use this for RAP behavior pool classes where ' +
    'main (global class with FOR BEHAVIOR OF) and implementations (lhc_* handler) must land ' +
    'together — writing them via two separate capituDevWriteObject calls produces HTTP 404 on the ' +
    'second write because the include resource only exists inside the session that wrote main. ' +
    'After this call, run capituDevActivate against the class objectUri.',
  category: 'code-write',
  inputSchema: writeClassBundleSchema,
  handler: async (input, ctx): Promise<WriteClassBundleOutput> => {
    assertWritesEnabled(ctx, input.packageName);
    const transport = await effectiveTransport(ctx.adt, input.packageName, input.transport);
    const result = await ctx.adt.writeClassBundle({
      classObjectUri: input.classObjectUri,
      transport,
      sources: input.sources,
    });
    return {
      written: result.written,
      lockReleased: result.lockReleased,
      hint: `Wrote ${result.written} source(s) under one lock. Next: call capituDevActivate against ${input.classObjectUri} (the class objectUri). For RAP behavior pools, activation may take 1-2s while SAP reconciles the CCIMP local class with the global FOR BEHAVIOR OF reference.`,
    };
  },
};

// ---- Activate ---------------------------------------------------------------

const activateSchema = z.object({
  objectName: z.string().min(1).describe('Object name as in TADIR (e.g. ZI_MY_VIEW).'),
  objectUri: z.string().min(1).describe('ADT object URI (NOT the source URI).'),
  mainInclude: z.string().optional().describe('For FUGR/PROG groups: the main include URI.'),
  packageName: z
    .string()
    .min(1)
    .describe('Package the object belongs to. Validated against allowlist.'),
});

export interface ActivateOutput {
  success: boolean;
  inactiveObjectsLeft: number;
  messages: Array<{ type: string; objectType?: string; objectName?: string; text: string }>;
}

export const activateTool: CapituTool<typeof activateSchema, ActivateOutput> = {
  name: 'capituDevActivate',
  description:
    'Activate an inactive ABAP object after editing. Returns activation messages from SAP ' +
    'including any errors that prevented activation. Requires CAPITU_ALLOW_WRITES=true and ' +
    'the package to be in CAPITU_ALLOWED_PACKAGES.',
  category: 'code-write',
  inputSchema: activateSchema,
  handler: async (input, ctx) => {
    assertWritesEnabled(ctx, input.packageName);
    const r = await ctx.adt.activate(input.objectName, input.objectUri, input.mainInclude);
    return {
      success: r.success,
      inactiveObjectsLeft: r.inactiveObjects,
      messages: r.messages,
    };
  },
};
