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
 * Instance management tools — list, inspect, and switch the active SAP system
 * at runtime. These are local config operations (category 'metadata-read',
 * endorsed): listing and inspecting never touch SAP; switching only probes the
 * target on request to confirm the connection landed on the right system.
 *
 * The active instance lives in the shared KB, so a switch here is observed by
 * capitu-docs and capitu-spec on their next tool call — one switch moves the
 * whole ecosystem's view.
 */

const emptySchema = z.object({});

const useSchema = z.object({
  name: z.string().min(1).describe('Name of the instance to activate (see capituDevListInstances)'),
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
  name: 'capituDevListInstances',
  description:
    'List the configured SAP instances (name, url, edition) and which one is active. ' +
    'Does not connect. Use this to see what systems you can switch between.',
  category: 'metadata-read',
  inputSchema: emptySchema,
  handler: async (_input, ctx): Promise<InstanceListOutput> => {
    const instances = ctx.registry.list();
    return { active: ctx.registry.activeName(), instances };
  },
};

export const whichInstanceTool: CapituTool<typeof emptySchema, InstanceSummary> = {
  name: 'capituDevWhichInstance',
  description:
    'Show the currently active SAP instance (name, url, user, client, edition). ' +
    'Does not connect. Use this to confirm which system writes/reads will hit.',
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
  name: 'capituDevUseInstance',
  description:
    'Switch the active SAP instance by name. Affects capitu-dev, capitu-docs and capitu-spec ' +
    '(shared via the KB). By default probes the target afterward to confirm edition/release ' +
    'AND which optional features (RAP, abapGit, transport, AMDP, UI5, HANA) it supports — so ' +
    'you can plan instead of trial-and-error. Feature results are cached in the KB.',
  category: 'metadata-read',
  inputSchema: useSchema,
  handler: async (input, ctx): Promise<UseInstanceOutput> => {
    const switched = await ctx.registry.switchTo(input.name);
    if (!input.probe) return { switched };
    const probe = await probeEnvironment(ctx.adt);
    const features = await probeFeatures(ctx.adt);
    persistFeatures(ctx, switched.name, features);
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

/**
 * Cache probed features in the shared tenant_catalog so other tools/sessions
 * can consult "what does the active system support" without re-probing.
 * Keyed by "<instance>:<feature>" under type 'feature'.
 */
function persistFeatures(
  ctx: { kb: import('better-sqlite3').Database },
  instance: string,
  features: FeatureStatus[],
): void {
  upsertCatalog(
    ctx.kb,
    features.map((f) => ({
      type: 'feature' as const,
      name: `${instance}:${f.id}`,
      metadata: { available: f.available, reason: f.reason },
    })),
  );
}
