import { grepSource } from '@capitu/adt-client';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

// ---- ReadObject -------------------------------------------------------------

const readObjectSchema = z.object({
  sourceUri: z
    .string()
    .min(1)
    .describe(
      'ADT source URI of the object. Examples: ' +
        '/sap/bc/adt/ddic/ddl/sources/zi_flight_gmivb/source/main, ' +
        '/sap/bc/adt/oo/classes/zcl_my_class/source/main',
    ),
});

export interface ReadObjectOutput {
  uri: string;
  source: string;
  lineCount: number;
}

export const readObjectTool: CapituTool<typeof readObjectSchema, ReadObjectOutput> = {
  name: 'capituDevReadObject',
  description:
    'Read the textual source of any ABAP/CDS object by its ADT source URI. ' +
    'Returns the full source plus line count. Useful for inspecting CDS views, ' +
    'classes, interfaces, behavior definitions, programs, etc.',
  category: 'code-read',
  inputSchema: readObjectSchema,
  handler: async (input, ctx) => {
    const out = await ctx.adt.getSource(input.sourceUri);
    return {
      uri: out.uri,
      source: out.source,
      lineCount: out.source.split('\n').length,
    };
  },
};

// ---- InspectPackage (structural attributes) --------------------------------

const inspectPackageSchema = z.object({
  packageName: z.string().min(1).describe('Package name (e.g. ZCASEN8N, $TMP).'),
});

export interface InspectPackageOutput {
  name: string;
  description: string;
  /** false ⇒ ANY create against this package returns TO-142 (server config gate). */
  isAddingObjectsAllowed: boolean;
  /** false ⇒ the flag is locked by software-component policy; cannot be changed in SE21/ADT. */
  isAddingObjectsAllowedEditable: boolean;
  packageType: string;
  transportLayer: string;
  softwareComponent: string;
  superPackage: string;
  responsible: string;
  /** True when something about the package would block a create attempt right now. */
  blocksCreation: boolean;
  /** Plain-Portuguese summary suitable for chat output. */
  diagnosis: string;
}

export const inspectPackageTool: CapituTool<typeof inspectPackageSchema, InspectPackageOutput> = {
  name: 'capituDevInspectPackage',
  description:
    'Read structural attributes of a package: isAddingObjectsAllowed (the TO-142 trigger), ' +
    'transportLayer, softwareComponent, packageType, responsible. Use BEFORE creating objects in ' +
    'a newly-minted package — TO-142 errors during create are almost always isAddingObjectsAllowed=false, ' +
    'which this tool surfaces explicitly. READ-ONLY; no side effects.',
  category: 'code-read',
  inputSchema: inspectPackageSchema,
  handler: async (input, ctx): Promise<InspectPackageOutput> => {
    const p = await ctx.adt.inspectPackage(input.packageName);
    const blocks = !p.isAddingObjectsAllowed;
    let diagnosis: string;
    if (blocks && p.isAddingObjectsAllowedEditable) {
      diagnosis = `Pacote '${p.name}' está com isAddingObjectsAllowed=false. QUALQUER create vai retornar TO-142 — não é problema de TR. Como isAddingObjectsAllowedEditable=true, você pode destravar: abrir o pacote no Eclipse em modo edição, toggle no checkbox "Adding further objects not possible" (marcar+desmarcar para forçar dirty), Ctrl+S na TR aberta.`;
    } else if (blocks && !p.isAddingObjectsAllowedEditable) {
      diagnosis = `Pacote '${p.name}' está com isAddingObjectsAllowed=false E não-editável (travado pela política do Software Component '${p.softwareComponent}'). Não dá pra destravar no SE21/ADT. Use outro pacote OU escolha um SC modificável.`;
    } else {
      diagnosis =
        `OK. Pacote '${p.name}' aceita criação. ` +
        `Software Component=${p.softwareComponent}, Transport Layer=${p.transportLayer}.`;
    }
    return {
      name: p.name,
      description: p.description,
      isAddingObjectsAllowed: p.isAddingObjectsAllowed,
      isAddingObjectsAllowedEditable: p.isAddingObjectsAllowedEditable,
      packageType: p.packageType,
      transportLayer: p.transportLayer,
      softwareComponent: p.softwareComponent,
      superPackage: p.superPackage,
      responsible: p.responsible,
      blocksCreation: blocks,
      diagnosis,
    };
  },
};

// ---- ReadPackage ------------------------------------------------------------

const readPackageSchema = z.object({
  packageName: z
    .string()
    .min(1)
    .describe('Package name. Use $TMP for local objects, or any Z*/Y*/SAP package.'),
});

export interface ReadPackageOutput {
  packageName: string;
  objects: Array<{ uri: string; type: string; name: string; description?: string }>;
  categories: string[];
}

export const readPackageTool: CapituTool<typeof readPackageSchema, ReadPackageOutput> = {
  name: 'capituDevReadPackage',
  description:
    'List immediate contents of a package (development class). Returns direct child ' +
    'objects and sub-categories (which may need a second call to enumerate). For tree ' +
    'navigation similar to Eclipse Project Explorer.',
  category: 'metadata-read',
  inputSchema: readPackageSchema,
  handler: async (input, ctx) => {
    const contents = await ctx.adt.listPackage(input.packageName);
    return {
      packageName: input.packageName,
      objects: contents.objects,
      categories: contents.categories,
    };
  },
};

// ---- Search -----------------------------------------------------------------

const searchSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Search pattern with SAP wildcards. Examples: "Z*", "ZI_FLIGHT*", "ZCL_MY_*".'),
  type: z
    .string()
    .optional()
    .describe(
      'Optional ADT object type filter: PROG, CLAS, INTF, DDLS, BDEF, SRVD, SRVB, DEVC, FUGR, TABL, DOMA, etc. Leave empty to search all types.',
    ),
  max: z.number().int().min(1).max(200).default(50),
});

export interface SearchOutput {
  total: number;
  hits: Array<{
    uri: string;
    type: string;
    name: string;
    packageName?: string;
    description?: string;
  }>;
}

export const searchTool: CapituTool<typeof searchSchema, SearchOutput> = {
  name: 'capituDevSearch',
  description:
    'Search the SAP object directory (TADIR) by pattern and optional type. ' +
    'Returns matching objects with their URI, type, name, package and description.',
  category: 'code-read',
  inputSchema: searchSchema,
  handler: async (input, ctx) => {
    const hits = await ctx.adt.search(input.pattern, input.type ?? '', input.max);
    return {
      total: hits.length,
      hits: hits.map((h) => ({
        uri: h.uri,
        type: h.type,
        name: h.name,
        packageName: h.packageName,
        description: h.description,
      })),
    };
  },
};

// ---- FindReferences ---------------------------------------------------------

const findRefsSchema = z.object({
  uri: z
    .string()
    .min(1)
    .describe('ADT URI of the object or source. For symbol-level lookup, include /source/main.'),
  line: z.number().int().min(1).optional().describe('Optional line for symbol-level lookup'),
  column: z.number().int().min(0).optional().describe('Optional column for symbol-level lookup'),
});

export interface FindReferencesOutput {
  total: number;
  references: Array<{
    uri: string;
    type: string;
    name: string;
    parent?: string;
    packageName?: string;
    description?: string;
  }>;
}

export const findReferencesTool: CapituTool<typeof findRefsSchema, FindReferencesOutput> = {
  name: 'capituDevFindReferences',
  description:
    'Find references (where-used) of an object or symbol. Without line/column, ' +
    'returns all places that consume this object. With line/column, narrows to a specific symbol.',
  category: 'code-read',
  inputSchema: findRefsSchema,
  handler: async (input, ctx) => {
    const refs = await ctx.adt.findReferences(input.uri, input.line, input.column);
    return {
      total: refs.length,
      references: refs,
    };
  },
};

// ---- Grep (regex search within an object's source) --------------------------

const grepSchema = z.object({
  sourceUri: z
    .string()
    .min(1)
    .describe('ADT source URI to search within (e.g. /sap/bc/adt/oo/classes/zcl_x/source/main).'),
  pattern: z
    .string()
    .min(1)
    .describe(
      'Case-insensitive regex to search for. Falls back to a literal search if the ' +
        'pattern is not valid regex (so "read_entities(" works without escaping).',
    ),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context on each side of a match (default 3).'),
  maxMatches: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum matches to render (default 100).'),
});

export interface GrepOutput {
  uri: string;
  matchCount: number;
  /** Formatted match report with 1-based line numbers + context. */
  report: string;
}

export const grepTool: CapituTool<typeof grepSchema, GrepOutput> = {
  name: 'capituDevGrep',
  description:
    "Regex-search WITHIN a single object's source and return only matching lines plus " +
    'a little surrounding context (not the full source). The token-efficient "search → ' +
    'locate → read" pattern: grep to find the line, then read around it. Case-insensitive, ' +
    'with literal fallback for unescaped metacharacters.',
  category: 'code-read',
  inputSchema: grepSchema,
  handler: async (input, ctx): Promise<GrepOutput> => {
    const src = await ctx.adt.getSource(input.sourceUri);
    const res = grepSource(src.source, input.pattern, {
      contextLines: input.contextLines,
      maxMatches: input.maxMatches,
    });
    return { uri: src.uri, matchCount: res.matchCount, report: res.output };
  },
};
