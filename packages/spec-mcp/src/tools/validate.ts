import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * capituSpecValidate checks a proposed spec against the connected tenant:
 *  - Does the target package exist and is it writable?
 *  - Do the artifact names collide with existing objects?
 *  - Are the basedOn references real (CDS, table, class)?
 *
 * Returns a checklist with concrete findings — not opinion, evidence from ADT.
 */

const itemSchema = z.object({
  kind: z.enum([
    'cds-interface',
    'cds-composite',
    'cds-projection',
    'cds-extension',
    'access-control',
    'behavior-definition',
    'behavior-implementation',
    'service-definition',
    'service-binding',
    'class',
    'interface',
    'table',
    'domain',
    'data-element',
  ]),
  name: z.string().min(1),
  basedOn: z.string().optional(),
});

const validateSchema = z.object({
  targetPackage: z.string().min(1),
  artifacts: z.array(itemSchema).min(1),
});

export interface ValidateOutput {
  ok: boolean;
  packageExists: boolean | 'unknown';
  findings: Array<{
    severity: 'error' | 'warning' | 'info';
    artifact?: string;
    message: string;
  }>;
}

const TYPE_TO_ADT_TYPE: Record<string, string> = {
  'cds-interface': 'DDLS',
  'cds-composite': 'DDLS',
  'cds-projection': 'DDLS',
  'cds-extension': 'DDLS',
  'access-control': 'DCLS',
  'behavior-definition': 'BDEF',
  'behavior-implementation': 'CLAS',
  'service-definition': 'SRVD',
  'service-binding': 'SRVB',
  class: 'CLAS',
  interface: 'INTF',
  table: 'TABL',
  domain: 'DOMA',
  'data-element': 'DTEL',
};

export const validateTool: CapituTool<typeof validateSchema, ValidateOutput> = {
  name: 'capituSpecValidate',
  description:
    'Validate a proposed spec against the connected SAP tenant: checks if the target package exists, ' +
    'if proposed artifact names already collide with existing objects, and if basedOn references are real. ' +
    'Read-only; never writes to SAP. Use after capituSpecDraft to catch issues before implementation.',
  category: 'metadata-read',
  inputSchema: validateSchema,
  handler: async (input, ctx) => {
    const findings: ValidateOutput['findings'] = [];

    // 1. Package check
    let packageExists: boolean | 'unknown' = 'unknown';
    try {
      const pkg = await ctx.adt.listPackage(input.targetPackage);
      packageExists = true;
      findings.push({
        severity: 'info',
        message: `Package ${input.targetPackage} exists. ${pkg.objects.length} direct objects, ${pkg.categories.length} sub-categories.`,
      });
    } catch (err) {
      packageExists = false;
      findings.push({
        severity: 'error',
        message: `Cannot read package ${input.targetPackage}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 2. Per-artifact collision + basedOn checks
    for (const art of input.artifacts) {
      const adtType = TYPE_TO_ADT_TYPE[art.kind];
      if (!adtType) continue;

      // Collision: does this name already exist?
      try {
        const hits = await ctx.adt.search(art.name, adtType, 5);
        const exact = hits.find((h) => h.name.toUpperCase() === art.name.toUpperCase());
        if (exact) {
          findings.push({
            severity: 'error',
            artifact: art.name,
            message: `Name collision: ${art.name} (${adtType}) already exists in package "${exact.packageName ?? '?'}". Pick a different name.`,
          });
        }
      } catch (err) {
        findings.push({
          severity: 'warning',
          artifact: art.name,
          message: `Could not check name collision: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // basedOn check: try to find the referenced object
      if (art.basedOn) {
        try {
          // Don't filter by type — basedOn could point at a table, view, or class
          const refs = await ctx.adt.search(art.basedOn, '', 5);
          const found = refs.find((h) => h.name.toUpperCase() === art.basedOn?.toUpperCase());
          if (!found) {
            findings.push({
              severity: 'warning',
              artifact: art.name,
              message: `Referenced object "${art.basedOn}" not found in tenant. Could be a missing released API, or a typo.`,
            });
          }
        } catch {
          // skip on error
        }
      }
    }

    const ok = !findings.some((f) => f.severity === 'error');
    return { ok, packageExists, findings };
  },
};
