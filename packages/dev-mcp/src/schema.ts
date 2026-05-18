import type { z } from 'zod';
import { zodToJsonSchema as zToJ } from 'zod-to-json-schema';

export function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
  const full = zToJ(schema, { target: 'jsonSchema7', $refStrategy: 'none' });
  const { $schema: _drop, ...rest } = full as Record<string, unknown>;
  return rest;
}
