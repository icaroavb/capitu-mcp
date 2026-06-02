import { documentObjectTool } from './document.js';
import { editMethodTool } from './edit-method.js';
import { learnTool, recallTool } from './learn.js';
import {
  findReferencesTool,
  inspectPackageTool,
  readObjectTool,
  readPackageTool,
  searchTool,
} from './read.js';
import {
  createServiceBindingTool,
  createServiceDefinitionTool,
  publishServiceBindingTool,
  unpublishServiceBindingTool,
} from './service.js';
import { checkTransportTool, listTransportsTool, transportContentsTool } from './transport.js';
import {
  activateTool,
  applyArtifactTool,
  createObjectTool,
  syntaxCheckTool,
  writeClassBundleTool,
  writeObjectTool,
} from './write.js';

export const ALL_TOOLS = [
  // Read group (5)
  readObjectTool,
  readPackageTool,
  inspectPackageTool,
  searchTool,
  findReferencesTool,
  // Check + atomic apply + granular write group (6)
  syntaxCheckTool,
  applyArtifactTool,
  createObjectTool,
  writeObjectTool,
  writeClassBundleTool,
  activateTool,
  // Method-level surgery (1) — surgical edit of one method inside a class
  editMethodTool,
  // Documentation (1) — exports .docx
  documentObjectTool,
  // Transport group (3)
  listTransportsTool,
  transportContentsTool,
  checkTransportTool,
  // RAP service stack (4) — SRVD, SRVB, publish, unpublish
  createServiceDefinitionTool,
  createServiceBindingTool,
  publishServiceBindingTool,
  unpublishServiceBindingTool,
  // Learnings (2) — cross-agent KB
  learnTool,
  recallTool,
] as const;

export type AnyCapituDevTool = (typeof ALL_TOOLS)[number];

export {
  readObjectTool,
  readPackageTool,
  inspectPackageTool,
  searchTool,
  findReferencesTool,
  syntaxCheckTool,
  applyArtifactTool,
  createObjectTool,
  writeObjectTool,
  writeClassBundleTool,
  activateTool,
  editMethodTool,
  documentObjectTool,
  listTransportsTool,
  transportContentsTool,
  checkTransportTool,
  createServiceDefinitionTool,
  createServiceBindingTool,
  publishServiceBindingTool,
  unpublishServiceBindingTool,
  learnTool,
  recallTool,
};
