import { type InstanceSummary, probeEnvironment } from '@capitu/adt-client';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * Instance management tools for capitu-docs — list, inspect, switch the active
 * SAP system at runtime. Category 'metadata-read' (endorsed): list/inspect
 * never connect; switch probes only on request. The active instance is shared
 * across the docs/dev/spec processes via the KB, so one switch moves all three.
 */

const emptySchema = z.object({});

const useSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Name of the instance to activate (see capituDocsListInstances)'),
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
  name: 'capituDocsListInstances',
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
  name: 'capituDocsWhichInstance',
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
}

export const useInstanceTool: CapituTool<typeof useSchema, UseInstanceOutput> = {
  name: 'capituDocsUseInstance',
  description:
    'Switch the active SAP instance by name. Affects capitu-dev, capitu-docs and capitu-spec ' +
    '(shared via the KB). By default probes the target afterward to confirm edition/release.',
  category: 'metadata-read',
  inputSchema: useSchema,
  handler: async (input, ctx): Promise<UseInstanceOutput> => {
    const switched = await ctx.registry.switchTo(input.name);
    if (!input.probe) return { switched };
    const probe = await probeEnvironment(ctx.adt);
    return {
      switched,
      probe: {
        edition: probe.edition,
        sapBasisRelease: probe.sapBasisRelease,
        objectTypeCount: probe.objectTypeCount,
        durationMs: probe.durationMs,
      },
    };
  },
};
