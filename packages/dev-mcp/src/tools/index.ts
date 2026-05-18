import { documentObjectTool } from './document.js';
import { learnTool, recallTool } from './learn.js';
import {
  findReferencesTool,
  readObjectTool,
  readPackageTool,
  searchTool,
} from './read.js';
import { listTransportsTool, transportContentsTool } from './transport.js';
import {
  activateTool,
  applyArtifactTool,
  createObjectTool,
  syntaxCheckTool,
  writeObjectTool,
} from './write.js';

export const ALL_TOOLS = [
  // Read group (4)
  readObjectTool,
  readPackageTool,
  searchTool,
  findReferencesTool,
  // Check + atomic apply + granular write group (5)
  syntaxCheckTool,
  applyArtifactTool,
  createObjectTool,
  writeObjectTool,
  activateTool,
  // Documentation (1) — exports .docx
  documentObjectTool,
  // Transport group (2)
  listTransportsTool,
  transportContentsTool,
  // Learnings (2) — cross-agent KB
  learnTool,
  recallTool,
] as const;

export type AnyCapituDevTool = (typeof ALL_TOOLS)[number];

export {
  readObjectTool,
  readPackageTool,
  searchTool,
  findReferencesTool,
  syntaxCheckTool,
  applyArtifactTool,
  createObjectTool,
  writeObjectTool,
  activateTool,
  documentObjectTool,
  listTransportsTool,
  transportContentsTool,
  learnTool,
  recallTool,
};
