import type { z } from 'zod';
import { zodToJsonSchema as zToJ } from 'zod-to-json-schema';

/**
 * Convert a Zod schema to JSON Schema for MCP tool listings.
 * Strips the $schema and definitions wrapper that zod-to-json-schema adds.
 */
export function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
  const full = zToJ(schema, { target: 'jsonSchema7', $refStrategy: 'none' });
  // MCP expects a plain object schema at the tool's inputSchema level.
  // Drop the outer "$schema" key if present.
  const { $schema: _drop, ...rest } = full as Record<string, unknown>;
  return rest;
}
