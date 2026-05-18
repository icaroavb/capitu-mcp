import { insertLearning, searchLearnings } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * Cross-agent learning: capitu-dev writes to the same KB that capitu-docs reads from.
 * When dev resolves a non-obvious issue (activation error, ATC finding, transport
 * gotcha, lock conflict), it records a learning here. Next time dev OR docs hits
 * a similar problem, capituDocsRecallLearnings retrieves it via vector similarity.
 *
 * The recorded sourceAgent='capitu-dev' lets future analytics distinguish where
 * the knowledge originated.
 */

const learnSchema = z.object({
  kind: z.enum(['error-fix', 'pattern', 'decision', 'gotcha']),
  problem: z.string().min(1),
  solution: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});

export type LearnOutput = { id: number; status: 'recorded'; embedDim: number };

export const learnTool: CapituTool<typeof learnSchema, LearnOutput> = {
  name: 'capituDevLearn',
  description:
    'Record a development learning into the shared Knowledge Base (visible to capitu-docs ' +
    'and future dev sessions). Use for: activation gotchas, ATC false positives, lock ' +
    'conflicts, transport tricks, package allowlist surprises.',
  category: 'docs-read', // writing to local KB, no SAP impact
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
        sourceAgent: 'capitu-dev',
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
  name: 'capituDevRecallLearnings',
  description:
    'Retrieve previously recorded learnings from BOTH capitu-dev and capitu-docs by ' +
    'semantic similarity. Use BEFORE attempting a fix to check prior knowledge.',
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
