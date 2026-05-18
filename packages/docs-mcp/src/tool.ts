import { assertCompliance, type ToolCategory, withTrace } from '@capitu/kb';
import type { z } from 'zod';
import type { ServerContext } from './context.js';

/**
 * A capitu tool is the unit registered in the MCP server.
 *
 * Every tool declares:
 *  - its compliance category (Q33 gate enforced before handler runs)
 *  - a Zod input schema (validated + exposed to LLM clients)
 *  - a handler that receives validated (parsed) input + ServerContext
 *
 * We use ZodTypeAny because Zod's input and output types diverge whenever a
 * schema has .default() or .transform(): input may be undefined, output never is.
 * Threading both through a generic is noisy without buying us safety here.
 *
 * The framework wraps the handler with:
 *  1. assertCompliance — denies in strict mode if category is gray-zone
 *  2. withTrace — records every call to traces table for audit
 */
export interface CapituTool<TSchema extends z.ZodTypeAny, TOutput> {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: TSchema;
  handler: (input: z.output<TSchema>, ctx: ServerContext) => Promise<TOutput>;
}

export async function runTool<TSchema extends z.ZodTypeAny, TOutput>(
  tool: CapituTool<TSchema, TOutput>,
  rawInput: unknown,
  ctx: ServerContext,
): Promise<TOutput> {
  assertCompliance(tool.category, ctx.compliance);
  const input = tool.inputSchema.parse(rawInput) as z.output<TSchema>;
  return withTrace(ctx.kb, ctx.agent, tool.name, input, () => tool.handler(input, ctx));
}
