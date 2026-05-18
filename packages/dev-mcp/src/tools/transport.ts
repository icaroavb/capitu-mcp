import { z } from 'zod';
import type { CapituTool } from '../tool.js';

// ---- ListTransports ---------------------------------------------------------

const listTransportsSchema = z.object({
  user: z
    .string()
    .optional()
    .describe(
      'Optional user name to list transports for. Defaults to the connected user.',
    ),
  state: z
    .enum(['modifiable', 'released', 'all'])
    .default('modifiable')
    .describe(
      'Filter by state: modifiable (open for edits, default), released (sealed), or all.',
    ),
  kind: z
    .enum(['workbench', 'customizing', 'all'])
    .default('workbench')
    .describe(
      'workbench (object changes, default), customizing (config changes), or all.',
    ),
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
  transportNumber: z
    .string()
    .min(1)
    .describe('Transport request number, e.g. NDCK900123.'),
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
