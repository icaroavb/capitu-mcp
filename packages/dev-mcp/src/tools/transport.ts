import { z } from 'zod';
import type { CapituTool } from '../tool.js';

// ---- ListTransports ---------------------------------------------------------

const listTransportsSchema = z.object({
  user: z
    .string()
    .optional()
    .describe('Optional user name to list transports for. Defaults to the connected user.'),
  state: z
    .enum(['modifiable', 'released', 'all'])
    .default('modifiable')
    .describe('Filter by state: modifiable (open for edits, default), released (sealed), or all.'),
  kind: z
    .enum(['workbench', 'customizing', 'all'])
    .default('workbench')
    .describe('workbench (object changes, default), customizing (config changes), or all.'),
});

export interface ListTransportsOutput {
  total: number;
  transports: Array<{
    number: string;
    owner: string;
    description: string;
    state: 'modifiable' | 'released';
    kind: 'workbench' | 'customizing';
    targetName?: string;
    objectCount: number;
  }>;
}

export const listTransportsTool: CapituTool<typeof listTransportsSchema, ListTransportsOutput> = {
  name: 'capituDevListTransports',
  description:
    'List transport requests owned by a user. Returns each transport with its number, ' +
    'description, status (modifiable/released), kind (workbench/customizing) and object count. ' +
    'Use this to find an existing TR to attach a new object to, before calling capituDevCreateObject ' +
    'or capituDevWriteObject with the transport parameter.',
  category: 'transport',
  inputSchema: listTransportsSchema,
  handler: async (input, ctx) => {
    const all = await ctx.adt.listTransports(input.user);
    const filtered = all.filter((t) => {
      if (input.state !== 'all' && t.state !== input.state) return false;
      if (input.kind === 'workbench' && !t.workbench) return false;
      if (input.kind === 'customizing' && t.workbench) return false;
      return true;
    });
    return {
      total: filtered.length,
      transports: filtered.map((t) => ({
        number: t.number,
        owner: t.owner,
        description: t.description,
        state: t.state,
        kind: t.workbench ? 'workbench' : 'customizing',
        targetName: t.targetName,
        objectCount: t.objectCount,
      })),
    };
  },
};

// ---- TransportContents ------------------------------------------------------

const transportContentsSchema = z.object({
  transportNumber: z.string().min(1).describe('Transport request number, e.g. NDCK900123.'),
});

export interface TransportContentsOutput {
  number: string;
  owner: string;
  description: string;
  status: string;
  taskCount: number;
  totalObjects: number;
  tasks: Array<{
    number: string;
    owner: string;
    description: string;
    status: string;
    objects: Array<{ pgmid: string; type: string; name: string; info?: string }>;
  }>;
}

export const transportContentsTool: CapituTool<
  typeof transportContentsSchema,
  TransportContentsOutput
> = {
  name: 'capituDevTransportContents',
  description:
    'Get the detailed contents of a transport request: tasks (sub-requests per developer), ' +
    'and all ABAP objects contained. Use to inspect what a TR will deliver, or to verify before releasing.',
  category: 'transport',
  inputSchema: transportContentsSchema,
  handler: async (input, ctx) => {
    const detail = await ctx.adt.transportContents(input.transportNumber);
    return {
      number: detail.number,
      owner: detail.owner,
      description: detail.description,
      status: detail.status,
      taskCount: detail.tasks.length,
      totalObjects: detail.allObjects.length,
      tasks: detail.tasks,
    };
  },
};

// ---- CheckTransport (read-only pre-flight) ---------------------------------

/**
 * ADT object URL builder for common object types. Mirrors the path layout
 * the ADT services use — we need this because /sap/bc/adt/cts/transportchecks
 * takes a URL, not a (type, name) pair.
 */
function buildObjectUrl(objectType: string, name: string): string {
  const ln = name.toLowerCase();
  switch (objectType) {
    case 'DDLS/DF':
      return `/sap/bc/adt/ddic/ddl/sources/${ln}`;
    case 'CLAS/OC':
      return `/sap/bc/adt/oo/classes/${ln}`;
    case 'INTF/OI':
      return `/sap/bc/adt/oo/interfaces/${ln}`;
    case 'DCLS/DL':
      return `/sap/bc/adt/acm/dcl/sources/${ln}`;
    case 'TABL/DT':
      return `/sap/bc/adt/ddic/tables/${ln}`;
    case 'DOMA/DD':
      return `/sap/bc/adt/ddic/domains/${ln}`;
    case 'DTEL/DE':
      return `/sap/bc/adt/ddic/dataelements/${ln}`;
    case 'PROG/P':
      return `/sap/bc/adt/programs/programs/${ln}`;
    case 'PROG/I':
      return `/sap/bc/adt/programs/includes/${ln}`;
    case 'SRVD/SRV':
      return `/sap/bc/adt/ddic/srvd/sources/${ln}`;
    case 'BDEF/BDO':
      return `/sap/bc/adt/bo/behaviordefinitions/${ln}`;
    case 'SRVB/SVB':
      return `/sap/bc/adt/businessservices/bindings/${ln}`;
    default:
      throw new Error(`buildObjectUrl: unsupported objectType '${objectType}'`);
  }
}

const checkTransportSchema = z.object({
  objectType: z
    .string()
    .min(1)
    .describe(
      'ADT type code (e.g. DOMA/DD, CLAS/OC, TABL/DT, DDLS/DF). Used to construct the canonical object URL.',
    ),
  name: z.string().min(1).describe('Object name (e.g. ZDO_PURREQ_ID).'),
  packageName: z.string().min(1).describe('Target package (e.g. ZN8N, $TMP).'),
  operation: z
    .enum(['I', ''])
    .default('I')
    .describe(
      '"I" for insert/create (default), "" (empty) for modify. SAP routes the check differently for each.',
    ),
});

export interface CheckTransportOutput {
  ok: boolean;
  recordingRequired: boolean;
  isLocal: boolean;
  deliveryUnit: string;
  devclass: string;
  candidateTransports: Array<{ number: string; description: string; owner: string }>;
  lockedInTransport?: string;
  errors: string[];
  warnings: string[];
  diagnosis: string;
}

export const checkTransportTool: CapituTool<typeof checkTransportSchema, CheckTransportOutput> = {
  name: 'capituDevCheckTransport',
  description:
    'READ-ONLY pre-flight for an object create/update. Calls /sap/bc/adt/cts/transportchecks ' +
    'to ask SAP whether (objectType, name, packageName) would be accepted, WITHOUT writing anything. ' +
    'Use BEFORE capituDevCreateObject or capituDevApplyArtifact when you hit TO-142 / TO-131 / ' +
    '"cannot assign object to package" errors — the response tells you whether the block is from the ' +
    'package attribute (isAddingObjectsAllowed), transport-layer mismatch, software-component ' +
    'non-modifiability, or an existing lock. No side effects.',
  category: 'transport',
  inputSchema: checkTransportSchema,
  handler: async (input, ctx): Promise<CheckTransportOutput> => {
    const objectUrl = buildObjectUrl(input.objectType, input.name);
    const result = await ctx.adt.checkTransport(objectUrl, input.packageName, input.operation);
    return {
      ok: result.errors.length === 0,
      recordingRequired: result.recordingRequired,
      isLocal: result.isLocal,
      deliveryUnit: result.deliveryUnit,
      devclass: result.devclass,
      candidateTransports: result.candidateTransports,
      lockedInTransport: result.lockedInTransport,
      errors: result.errors,
      warnings: result.warnings,
      diagnosis: diagnoseCheck(result),
    };
  },
};

/**
 * Human-readable diagnosis of a TransportCheckResult. Captures the common
 * S/4HANA failure modes for object → package assignment in one sentence.
 */
function diagnoseCheck(r: import('@capitu/adt-client').TransportCheckResult): string {
  if (r.errors.length > 0) {
    // Try to recognize known error patterns.
    const joined = r.errors.join(' | ').toUpperCase();
    if (
      joined.includes('TO142') ||
      joined.includes('TO-142') ||
      joined.includes('CANNOT BE ASSIGNED')
    ) {
      return (
        'TO-142: Object cannot be assigned to this package. Common causes: (1) package transport ' +
        "layer differs from your TR's target system; (2) the package's software component is " +
        'non-modifiable in this system; (3) the package is structural-only ("Adding Objects Allowed" off in SE21).'
      );
    }
    if (joined.includes('TO131') || joined.includes('TO-131')) {
      return 'TO-131: Namespace requires a transport request. Pass an open workbench TR.';
    }
    if (joined.includes('LOCKED') || joined.includes('TRKORR')) {
      return `Object is currently locked in transport ${r.lockedInTransport ?? '(unknown)'}. Release or unlock that TR first.`;
    }
    return `Errors from SAP: ${r.errors.join('; ')}`;
  }
  if (r.isLocal) {
    return 'Package is LOCAL (no transport required). Pass packageName="$TMP" without a transport argument.';
  }
  if (r.recordingRequired && r.candidateTransports.length === 0) {
    return 'Recording is required but no candidate TRs found. Open a workbench TR (SE09) and retry.';
  }
  if (r.candidateTransports.length > 0) {
    return `OK. Candidate transports: ${r.candidateTransports.map((t) => t.number).join(', ')}.`;
  }
  return 'OK. No errors and recording not required.';
}
