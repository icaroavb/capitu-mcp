import { insertLearning, searchLearnings } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * capitu-spec uses the same KB as docs/dev. When the spec agent realizes a
 * pattern (e.g. "every booking entity needs custom status enum"), it records
 * it here. Future spec drafts can recall similar past decisions.
 */

const learnSchema = z.object({
  kind: z.enum(['error-fix', 'pattern', 'decision', 'gotcha']),
  problem: z.string().min(1),
  solution: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});

export type LearnOutput = { id: number; status: 'recorded'; embedDim: number };

export const learnTool: CapituTool<typeof learnSchema, LearnOutput> = {
  name: 'capituSpecLearn',
  description:
    'Record a spec/architecture learning into the shared Knowledge Base. Use for: design decisions, ' +
    'rejected alternatives with rationale, recurring patterns (e.g. "RAP managed implementation needs ' +
    'late numbering for X reason"), naming conventions agreed with the team.',
  category: 'docs-read',
  inputSchema: learnSchema,
  handler: async (input, ctx) => {
    const [emb] = await ctx.embeddings.embed([`${input.problem}\n${input.solution}`]);
    if (!emb) throw new Error('Embedding failed (empty result)');
    const id = insertLearning(
      ctx.kb,
      {
        kind: input.kind,
        problem: input.problem,
        solution: input.solution,
        context: input.context,
        sourceAgent: 'capitu-spec',
      },
      emb,
    );
    return { id, status: 'recorded', embedDim: emb.length };
  },
};

const recallSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).default(3),
  kind: z.enum(['error-fix', 'pattern', 'decision', 'gotcha']).optional(),
  onlyValidated: z.boolean().default(false),
});

export interface RecallOutput {
  matches: Array<{
    id: number;
    kind: string;
    problem: string;
    solution: string;
    context?: unknown;
    validatedAt: string | null;
    sourceAgent: string;
  }>;
}

export const recallTool: CapituTool<typeof recallSchema, RecallOutput> = {
  name: 'capituSpecRecallLearnings',
  description:
    'Retrieve previously recorded learnings (from spec, dev OR docs agents) by semantic similarity. ' +
    'Use BEFORE drafting a new spec to surface relevant past decisions or rejected alternatives.',
  category: 'docs-read',
  inputSchema: recallSchema,
  handler: async (input, ctx) => {
    // Falls back to LIKE-based keyword search when no embedding (BM25 mode).
    const [emb] = await ctx.embeddings.embed([input.query]);
    const hits = searchLearnings(ctx.kb, emb ?? [], {
      limit: input.limit,
      kind: input.kind,
      onlyValidated: input.onlyValidated,
      queryText: input.query,
    });
    return {
      matches: hits.map((h) => ({
        id: h.id,
        kind: h.kind,
        problem: h.problem,
        solution: h.solution,
        context: h.context,
        validatedAt: h.validatedAt,
        sourceAgent: h.sourceAgent,
      })),
    };
  },
};
