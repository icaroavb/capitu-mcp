import { probeEnvironment } from '@capitu/adt-client';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

const inputSchema = z.object({
  packages: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Optional list of user packages to enumerate. Defaults to $TMP only.'),
  searchPattern: z
    .string()
    .optional()
    .describe('Optional search pattern (e.g. "Z*", "ZI_*") to scan user namespace'),
  searchType: z
    .string()
    .optional()
    .describe('Optional object type filter for the search pattern (e.g. "DDLS", "CLAS")'),
});

export interface TenantContextOutput {
  connection: {
    url: string;
    user: string;
    client?: string;
  };
  environment: {
    edition: string;
    sapBasisRelease: string | null;
    objectTypeCount: number;
    probedAt: string;
    durationMs: number;
  };
  packages: Array<{
    name: string;
    objects: Array<{ uri: string; type: string; name: string; description?: string }>;
    categories: string[];
  }>;
  searchHits?: Array<{
    uri: string;
    type: string;
    name: string;
    packageName?: string;
    description?: string;
  }>;
}

export const tenantContextTool: CapituTool<typeof inputSchema, TenantContextOutput> = {
  name: 'capituDocsTenantContext',
  description:
    'Inspect the connected SAP tenant. Returns the SAP edition, release, count of object ' +
    'types, contents of user packages and optionally results of a custom search. Use this ' +
    'at the start of a session to ground subsequent suggestions on what the tenant actually has.',
  category: 'metadata-read',
  inputSchema,
  handler: async (input, ctx): Promise<TenantContextOutput> => {
    const adt = ctx.adt;
    const probe = await probeEnvironment(adt);

    const pkgNames = input.packages ?? ['$TMP'];
    const packages = await Promise.all(
      pkgNames.map(async (name) => {
        try {
          const contents = await adt.listPackage(name);
          return { name, objects: contents.objects, categories: contents.categories };
        } catch (err) {
          return {
            name,
            objects: [],
            categories: [],
            error: err instanceof Error ? err.message : String(err),
          } as never;
        }
      }),
    );

    let searchHits: TenantContextOutput['searchHits'];
    if (input.searchPattern) {
      const hits = await adt.search(input.searchPattern, input.searchType ?? '', 20);
      searchHits = hits.map((h) => ({
        uri: h.uri,
        type: h.type,
        name: h.name,
        packageName: h.packageName,
        description: h.description,
      }));
    }

    return {
      connection: {
        url: adt.url,
        user: adt.user,
        client: adt.client,
      },
      environment: {
        edition: probe.edition,
        sapBasisRelease: probe.sapBasisRelease,
        objectTypeCount: probe.objectTypeCount,
        probedAt: probe.probedAt,
        durationMs: probe.durationMs,
      },
      packages,
      searchHits,
    };
  },
};
