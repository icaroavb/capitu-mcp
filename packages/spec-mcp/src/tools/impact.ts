import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * capituSpecImpactAnalysis answers "what breaks if I change X?".
 *
 * Strategy: do a where-used on the target object, then bucket results by type
 * (CDS, BDEF, classes, services). For RAP this is the difference between a
 * safe rename (no consumers) and a high-risk change (consumed by 5 BDEFs and
 * a service binding).
 */

const impactSchema = z.object({
  uri: z
    .string()
    .min(1)
    .describe('ADT URI of the object being analyzed (e.g. /sap/bc/adt/ddic/ddl/sources/zi_flight_gmivb)'),
});

export interface ImpactOutput {
  uri: string;
  totalConsumers: number;
  byType: Record<string, number>;
  byPackage: Record<string, number>;
  highlights: Array<{ type: string; name: string; package?: string; description?: string }>;
  riskTier: 'isolated' | 'low' | 'medium' | 'high';
  summary: string;
}

export const impactTool: CapituTool<typeof impactSchema, ImpactOutput> = {
  name: 'capituSpecImpactAnalysis',
  description:
    'Analyze the blast radius of changing an existing ABAP object. Runs where-used, groups consumers ' +
    'by type and package, classifies risk as isolated / low / medium / high. Use BEFORE editing released objects ' +
    'or shared CDS views. Read-only.',
  category: 'code-read',
  inputSchema: impactSchema,
  handler: async (input, ctx) => {
    const refs = await ctx.adt.findReferences(input.uri);

    const byType: Record<string, number> = {};
    const byPackage: Record<string, number> = {};
    for (const r of refs) {
      const t = r.type.split('/')[0] ?? r.type;
      byType[t] = (byType[t] ?? 0) + 1;
      if (r.packageName) {
        byPackage[r.packageName] = (byPackage[r.packageName] ?? 0) + 1;
      }
    }

    const total = refs.length;
    const tier: ImpactOutput['riskTier'] =
      total === 0
        ? 'isolated'
        : total <= 3
          ? 'low'
          : total <= 10
            ? 'medium'
            : 'high';

    const highlights = refs.slice(0, 10).map((r) => ({
      type: r.type,
      name: r.name,
      package: r.packageName,
      description: r.description,
    }));

    const summary = buildSummary(input.uri, total, tier, byType, byPackage);

    return {
      uri: input.uri,
      totalConsumers: total,
      byType,
      byPackage,
      highlights,
      riskTier: tier,
      summary,
    };
  },
};

function buildSummary(
  uri: string,
  total: number,
  tier: ImpactOutput['riskTier'],
  byType: Record<string, number>,
  byPackage: Record<string, number>,
): string {
  if (tier === 'isolated') {
    return `${uri} has no known consumers. Safe to rename, remove or restructure.`;
  }
  const typeList = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');
  const pkgCount = Object.keys(byPackage).length;
  return (
    `${uri} has ${total} consumer(s) across ${pkgCount} package(s): ${typeList}. ` +
    `Risk tier: ${tier}. ${tier === 'high' ? 'Coordinate with downstream owners before changing.' : 'Review the highlights list before changing.'}`
  );
}
