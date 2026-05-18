import { searchDocs } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

const inputSchema = z.object({
  query: z.string().min(1).describe('Natural language or keyword query (Portuguese or English)'),
  limit: z.number().int().min(1).max(20).default(5).describe('Maximum results to return'),
  source: z
    .enum(['abap-keyword', 'help-portal', 'community', 'github-samples'])
    .optional()
    .describe('Filter by documentation source'),
  release: z.string().optional().describe('Filter by SAP release (e.g. "7.58", "cloud")'),
});

export interface SearchOutput {
  hits: Array<{
    title: string;
    source: string;
    release?: string;
    url?: string;
    score: number;
    snippet: string;
  }>;
  totalIndexed: number;
}

export const searchTool: CapituTool<typeof inputSchema, SearchOutput> = {
  name: 'capituDocsSearch',
  description:
    'Hybrid search (BM25 + vector) over the capitu Knowledge Base of SAP documentation. ' +
    'Searches ABAP keyword docs, SAP Help Portal pages, Community blogs and code samples ' +
    'that have been indexed. Returns top results ranked by combined relevance score.',
  category: 'docs-read',
  inputSchema,
  handler: async (input, ctx) => {
    // Empty embedding (BM25-only mode) is a valid input — search.ts handles it.
    const [queryEmb] = await ctx.embeddings.embed([input.query]);
    const hits = searchDocs(ctx.kb, input.query, queryEmb ?? [], {
      limit: input.limit,
      source: input.source,
      release: input.release,
    });
    const total = (ctx.kb.prepare('SELECT COUNT(*) as c FROM docs').get() as { c: number }).c;
    return {
      hits: hits.map((h) => ({
        title: h.title,
        source: h.source,
        release: h.release,
        url: h.url,
        score: Number(h.score.toFixed(4)),
        snippet: snippet(h.content, input.query),
      })),
      totalIndexed: total,
    };
  },
};

/** Extract a ~200-char window around the first query-term match, or doc start. */
function snippet(content: string, query: string): string {
  const max = 240;
  const firstWord = query.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!firstWord) return content.slice(0, max);
  const idx = content.toLowerCase().indexOf(firstWord);
  if (idx < 0) return content.slice(0, max);
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, start + max);
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}
