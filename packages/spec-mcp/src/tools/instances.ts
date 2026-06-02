import {
  type FeatureStatus,
  type InstanceSummary,
  probeEnvironment,
  probeFeatures,
} from '@capitu/adt-client';
import { upsertCatalog } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * Instance management tools for capitu-spec — list, inspect, switch the active
 * SAP system at runtime. Category 'metadata-read' (endorsed): list/inspect
 * never connect; switch probes only on request. The active instance is shared
 * across the docs/dev/spec processes via the KB, so one switch moves all three.
 */

const emptySchema = z.object({});

const useSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Name of the instance to activate (see capituSpecListInstances)'),
  probe: z
    .boolean()
    .optional()
    .default(true)
    .describe('Probe the target after switching to confirm edition/release/reachability'),
});

export interface InstanceListOutput {
  active: string;
  instances: InstanceSummary[];
}

export const listInstancesTool: CapituTool<typeof emptySchema, InstanceListOutput> = {
  name: 'capituSpecListInstances',
  description:
    'List the configured SAP instances (name, url, edition) and which one is active. ' +
    'Does not connect.',
  category: 'metadata-read',
  inputSchema: emptySchema,
  handler: async (_input, ctx): Promise<InstanceListOutput> => {
    const instances = ctx.registry.list();
    return { active: ctx.registry.activeName(), instances };
  },
};

export const whichInstanceTool: CapituTool<typeof emptySchema, InstanceSummary> = {
  name: 'capituSpecWhichInstance',
  description:
    'Show the currently active SAP instance (name, url, user, client, edition). Does not connect.',
  category: 'metadata-read',
  inputSchema: emptySchema,
  handler: async (_input, ctx): Promise<InstanceSummary> => {
    const active = ctx.registry.activeName();
    const found = ctx.registry.list().find((i) => i.name === active);
    if (!found) throw new Error(`Active instance "${active}" not found in configuration.`);
    return found;
  },
};

export interface UseInstanceOutput {
  switched: InstanceSummary;
  probe?: {
    edition: string;
    sapBasisRelease: string | null;
    objectTypeCount: number;
    durationMs: number;
  };
  /** Which optional capabilities the target system supports (when probed). */
  features?: FeatureStatus[];
}

export const useInstanceTool: CapituTool<typeof useSchema, UseInstanceOutput> = {
  name: 'capituSpecUseInstance',
  description:
    'Switch the active SAP instance by name. Affects capitu-dev, capitu-docs and capitu-spec ' +
    '(shared via the KB). By default probes the target for edition/release AND optional features ' +
    '(RAP, abapGit, transport, AMDP, UI5, HANA), caching them in the KB.',
  category: 'metadata-read',
  inputSchema: useSchema,
  handler: async (input, ctx): Promise<UseInstanceOutput> => {
    const switched = await ctx.registry.switchTo(input.name);
    if (!input.probe) return { switched };
    const probe = await probeEnvironment(ctx.adt);
    const features = await probeFeatures(ctx.adt);
    upsertCatalog(
      ctx.kb,
      features.map((f) => ({
        type: 'feature' as const,
        name: `${switched.name}:${f.id}`,
        metadata: { available: f.available, reason: f.reason },
      })),
    );
    return {
      switched,
      probe: {
        edition: probe.edition,
        sapBasisRelease: probe.sapBasisRelease,
        objectTypeCount: probe.objectTypeCount,
        durationMs: probe.durationMs,
      },
      features,
    };
  },
};
