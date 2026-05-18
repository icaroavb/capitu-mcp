import { applyTool } from './apply.js';
import { draftTool } from './draft.js';
import {
  exportDocxTool,
  exportProposalTool,
  listOutputsTool,
} from './export.js';
import { impactTool } from './impact.js';
import { learnTool, recallTool } from './learn.js';
import { listProposalsTool } from './proposals-list.js';
import { proposeTool } from './propose.js';
import { validateTool } from './validate.js';

export const ALL_TOOLS = [
  // Spec authoring (1)
  draftTool,
  // Executable proposal flow (3) — propose → review → apply
  proposeTool,
  applyTool,
  listProposalsTool,
  // Validation against tenant reality (2)
  validateTool,
  impactTool,
  // DOCX/MD output (3) — persist into capitu-output/
  exportDocxTool,
  exportProposalTool,
  listOutputsTool,
  // Learnings cross-agent (2)
  learnTool,
  recallTool,
] as const;

export type AnyCapituSpecTool = (typeof ALL_TOOLS)[number];

export {
  draftTool,
  proposeTool,
  applyTool,
  listProposalsTool,
  validateTool,
  impactTool,
  exportDocxTool,
  exportProposalTool,
  listOutputsTool,
  learnTool,
  recallTool,
};
