import { listInstancesTool, useInstanceTool, whichInstanceTool } from './instances.js';
import { learnTool, recallLearningsTool, validateLearningTool } from './learn.js';
import { searchTool } from './search.js';
import { tenantContextTool } from './tenant.js';

/**
 * Heterogeneous list of tools. The schema parameter varies per tool, so the
 * element type stays inferred at the union of all tool types — the MCP server
 * never needs to inspect inputSchema generically beyond passing it to Zod.
 */
export const ALL_TOOLS = [
  searchTool,
  learnTool,
  recallLearningsTool,
  validateLearningTool,
  tenantContextTool,
  // Instance management (3) — list/inspect/switch active SAP system at runtime
  listInstancesTool,
  whichInstanceTool,
  useInstanceTool,
] as const;

export type AnyCapituTool = (typeof ALL_TOOLS)[number];

export {
  searchTool,
  learnTool,
  recallLearningsTool,
  validateLearningTool,
  tenantContextTool,
  listInstancesTool,
  whichInstanceTool,
  useInstanceTool,
};
