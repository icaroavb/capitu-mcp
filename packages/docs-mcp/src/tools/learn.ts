import { insertLearning, searchLearnings, validateLearning } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

// ---- learn ------------------------------------------------------------------

const learnSchema = z.object({
  kind: z
    .enum(['error-fix', 'pattern', 'decision', 'gotcha'])
    .describe(
      'Type of learning: error-fix (problem→solution), pattern (reusable approach), ' +
        'decision (architectural choice with rationale), gotcha (surprising behavior to remember)',
    ),
  problem: z.string().min(1).describe('What was the problem, question or trigger'),
  solution: z.string().min(1).describe('What was the solution, decision or behavior observed'),
  context: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional structured context (e.g. { objectUri, release, package, errorCode })',
    ),
});

export type LearnOutput = { id: number; status: 'recorded'; embedDim: number };

export const learnTool: CapituTool<typeof learnSchema, LearnOutput> = {
  name: 'capituDocsLearn',
  description:
    'Record a new learning into the shared Knowledge Base. Use this when you discover ' +
    'a non-obvious behavior, fix a tricky error, choose between alternatives with reasoning, ' +
    'or want a fact to be retrievable in future sessions. The learning is indexed by vector ' +
    'similarity and shared with capitu-dev and capitu-spec.',
  category: 'docs-read', // writing to KB is local, no SAP-side impact
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
        sourceAgent: ctx.agent,
      },
      emb,
    );
    return { id, status: 'recorded', embedDim: emb.length };
  },
};

// ---- recallLearnings --------------------------------------------------------

const recallSchema = z.object({
  query: z.string().min(1).describe('Describe the current problem or topic'),
  limit: z.number().int().min(1).max(10).default(3),
  kind: z
    .enum(['error-fix', 'pattern', 'decision', 'gotcha'])
    .optional()
    .describe('Restrict to a single kind'),
  onlyValidated: z
    .boolean()
    .default(false)
    .describe('If true, return only learnings the user has explicitly confirmed'),
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

export const recallLearningsTool: CapituTool<typeof recallSchema, RecallOutput> = {
  name: 'capituDocsRecallLearnings',
  description:
    'Retrieve previously recorded learnings that are semantically similar to a query. ' +
    'Use this BEFORE attempting to solve a problem to check if you (or another agent) ' +
    'has already encountered and solved something similar.',
  category: 'docs-read',
  inputSchema: recallSchema,
  handler: async (input, ctx) => {
    // In BM25-only mode (NullEmbeddings), provider returns empty arrays;
    // searchLearnings then uses queryText for a LIKE-based fallback.
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

// ---- validateLearning -------------------------------------------------------

const validateSchema = z.object({
  id: z.number().int().positive().describe('Learning id returned by capituDocsLearn'),
});
export type ValidateOutput = { id: number; status: 'validated' };

export const validateLearningTool: CapituTool<typeof validateSchema, ValidateOutput> = {
  name: 'capituDocsValidateLearning',
  description:
    'Mark a previously recorded learning as user-validated. Validated learnings are ' +
    'prioritized in future recall when onlyValidated=true is used.',
  category: 'docs-read',
  inputSchema: validateSchema,
  handler: async (input, ctx) => {
    validateLearning(ctx.kb, input.id);
    return { id: input.id, status: 'validated' };
  },
};
