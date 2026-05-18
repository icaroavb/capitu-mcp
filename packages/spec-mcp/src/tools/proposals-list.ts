import { listProposals } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

const listSchema = z.object({
  status: z
    .enum(['pending', 'applied', 'cancelled', 'partial', 'all'])
    .default('pending')
    .describe('Filter by status. Default: pending only.'),
  limit: z.number().int().min(1).max(50).default(10),
});

export interface ListProposalsOutput {
  total: number;
  proposals: Array<{
    token: string;
    title: string;
    targetPackage: string;
    status: string;
    createdAt: string;
    appliedAt: string | null;
  }>;
}

export const listProposalsTool: CapituTool<typeof listSchema, ListProposalsOutput> = {
  name: 'capituSpecListProposals',
  description:
    'List spec proposals stored in the KB, optionally filtered by status. Useful to find a token for ' +
    'capituSpecApply when you lost it, or to audit what was already applied/cancelled.',
  category: 'docs-read',
  inputSchema: listSchema,
  handler: async (input, ctx) => {
    const all = listProposals(
      ctx.kb,
      input.status === 'all' ? undefined : input.status,
    );
    const sliced = all.slice(0, input.limit);
    return {
      total: all.length,
      proposals: sliced.map((p) => ({
        token: p.token,
        title: p.title,
        targetPackage: p.targetPackage,
        status: p.status,
        createdAt: p.createdAt,
        appliedAt: p.appliedAt,
      })),
    };
  },
};
