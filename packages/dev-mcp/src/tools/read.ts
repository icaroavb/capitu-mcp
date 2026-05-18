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
