import { assertCompliance, type ToolCategory, withTrace } from '@capitu/kb';
import type { z } from 'zod';
import type { ServerContext } from './context.js';

/**
 * Same shape as docs-mcp's tool framework. Each tool declares its compliance
 * category; runTool runs the gate, parses input via Zod, and traces every call.
 *
 * Intentional duplication: keeping each MCP self-contained is cheaper than a
 * shared "framework" package while we have only two MCPs.
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
