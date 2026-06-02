import { getProposal, listOutputs, writeMarkdownAsDocx, writeMarkdownAsMd } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * Generic export: receives markdown content + title + category and writes
 * a .docx (default) or .md file under the capitu-output/<category>/ folder.
 *
 * Use cases:
 *  - LLM produced a long analysis in chat and wants to persist it
 *  - User asks "save that proposal as docx so I can share"
 *  - Document a learning / decision in a shareable file
 */

const exportDocxSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .describe('Title shown at the top of the document; also used to build the filename.'),
  markdown: z
    .string()
    .min(1)
    .describe('Markdown content to render. Supports headings, tables, bullets, code blocks.'),
  category: z
    .enum(['documentation', 'specifications', 'analysis'])
    .describe(
      'documentation = code documentation, specifications = functional/technical specs, analysis = ad-hoc analyses.',
    ),
  format: z.enum(['docx', 'md']).default('docx').describe('docx (default) or md fallback.'),
  filename: z
    .string()
    .optional()
    .describe('Custom filename (without extension). If omitted, derives from title + timestamp.'),
});

export interface ExportDocxOutput {
  path: string;
  filename: string;
  bytes: number;
  category: string;
  format: string;
}

export const exportDocxTool: CapituTool<typeof exportDocxSchema, ExportDocxOutput> = {
  name: 'capituSpecExportDocx',
  description:
    'Export a markdown document to capitu-output/<category>/ as .docx (or .md). Title becomes the document title and part of the filename. Categories: documentation (code docs), specifications (functional/technical specs), analysis (ad-hoc analyses). The output folder is set by CAPITU_OUTPUT_DIR or defaults to <project>/capitu-output/.',
  category: 'docs-read',
  inputSchema: exportDocxSchema,
  handler: async (input) => {
    const finalName = input.filename ? `${input.filename}.${input.format}` : undefined;
    const result =
      input.format === 'docx'
        ? await writeMarkdownAsDocx({
            markdown: input.markdown,
            title: input.title,
            category: input.category,
            filename: finalName,
          })
        : writeMarkdownAsMd({
            markdown: input.markdown,
            title: input.title,
            category: input.category,
            filename: finalName,
          });
    return {
      path: result.path,
      filename: result.filename,
      bytes: result.bytes,
      category: result.category,
      format: input.format,
    };
  },
};

// ---- Export proposal by token ----------------------------------------------

const exportProposalSchema = z.object({
  token: z.string().uuid().describe('Proposal token returned by capituSpecPropose.'),
  format: z.enum(['docx', 'md']).default('docx'),
});

export const exportProposalTool: CapituTool<typeof exportProposalSchema, ExportDocxOutput> = {
  name: 'capituSpecExportProposalDocx',
  description:
    'Export a previously-proposed spec (by token) as a docx/md file under capitu-output/specifications/. Useful for sharing the proposal with stakeholders before applying. The proposal does not have to be applied or pending; any token works.',
  category: 'docs-read',
  inputSchema: exportProposalSchema,
  handler: async (input, ctx) => {
    const proposal = getProposal<{ title: string; targetPackage: string }>(ctx.kb, input.token);
    if (!proposal) {
      throw new Error(
        `Proposal with token "${input.token}" not found. Run capituSpecListProposals to find one.`,
      );
    }
    // Re-render markdown from the stored payload via specToMarkdown is not
    // straightforward because the propose tool already returned the markdown
    // and we don't store it. So we render a compact view from the stored fields.
    const payload = proposal.payload as {
      title: string;
      targetPackage: string;
      artifacts: Array<{ name: string; kind: string; description: string; source?: string }>;
      executionOrder: string[];
    };
    const md = renderProposalAsMarkdown(
      payload,
      proposal.token,
      proposal.status,
      proposal.createdAt,
    );
    const result =
      input.format === 'docx'
        ? await writeMarkdownAsDocx({
            markdown: md,
            title: payload.title,
            category: 'specifications',
          })
        : writeMarkdownAsMd({
            markdown: md,
            title: payload.title,
            category: 'specifications',
          });
    return {
      path: result.path,
      filename: result.filename,
      bytes: result.bytes,
      category: result.category,
      format: input.format,
    };
  },
};

function renderProposalAsMarkdown(
  payload: {
    title: string;
    targetPackage: string;
    artifacts: Array<{ name: string; kind: string; description: string; source?: string }>;
    executionOrder: string[];
  },
  token: string,
  status: string,
  createdAt: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${payload.title}`);
  lines.push('');
  lines.push(`**Proposal token:** \`${token}\``);
  lines.push(`**Status:** ${status}`);
  lines.push(`**Created at:** ${createdAt}`);
  lines.push(`**Target package:** \`${payload.targetPackage}\``);
  lines.push('');
  lines.push('## Execution order');
  payload.executionOrder.forEach((n, i) => lines.push(`${i + 1}. \`${n}\``));
  lines.push('');
  lines.push('## Artifacts');
  for (const a of payload.artifacts) {
    lines.push('');
    lines.push(`### \`${a.name}\` — ${a.kind}`);
    lines.push('');
    lines.push(a.description);
    if (a.source) {
      lines.push('');
      lines.push('```abap');
      lines.push(a.source.trim());
      lines.push('```');
    }
  }
  return lines.join('\n');
}

// ---- List outputs ----------------------------------------------------------

const listOutputsSchema = z.object({
  category: z
    .enum(['documentation', 'specifications', 'analysis', 'all'])
    .default('all')
    .describe('Filter by category. Default: all.'),
});

export interface ListOutputsResult {
  baseDir: string;
  total: number;
  files: Array<{
    category: string;
    filename: string;
    bytes: number;
    modifiedAt: string;
  }>;
}

export const listOutputsTool: CapituTool<typeof listOutputsSchema, ListOutputsResult> = {
  name: 'capituSpecListOutputs',
  description:
    'List documents already generated under capitu-output/. Use to find what has been documented or specified already, with timestamps. Read-only.',
  category: 'docs-read',
  inputSchema: listOutputsSchema,
  handler: async (input) => {
    const listing = listOutputs();
    const files: ListOutputsResult['files'] = [];
    for (const cat of Object.keys(listing.byCategory) as Array<keyof typeof listing.byCategory>) {
      if (input.category !== 'all' && input.category !== cat) continue;
      for (const f of listing.byCategory[cat]) {
        files.push({
          category: cat,
          filename: f.filename,
          bytes: f.bytes,
          modifiedAt: f.modifiedAt,
        });
      }
    }
    files.sort((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1));
    return { baseDir: listing.baseDir, total: files.length, files };
  },
};
