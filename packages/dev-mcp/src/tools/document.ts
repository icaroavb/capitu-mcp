import { writeMarkdownAsDocx } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * capituDevDocumentObject reads an ABAP/CDS object via ADT and produces a
 * technical documentation .docx in capitu-output/documentation/.
 *
 * What goes in the doc:
 *   - Object header (name, type, package, description from search)
 *   - Source code (read via getSource)
 *   - Where-used summary (top consumers via findReferences, capped)
 *
 * The LLM client can ask "documenta a CDS ZI_MY_VIEW" and this tool does
 * the four ADT round-trips + DOCX synthesis without hand-holding.
 */

const docSchema = z.object({
  sourceUri: z
    .string()
    .min(1)
    .describe(
      'ADT source URI ending in /source/main (e.g. /sap/bc/adt/ddic/ddl/sources/zi_test_capitu/source/main)',
    ),
  includeWhereUsed: z
    .boolean()
    .default(true)
    .describe('If true, runs where-used and includes a "Consumers" section.'),
  whereUsedLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(15)
    .describe('Cap on number of consumers to list.'),
});

export interface DocumentObjectOutput {
  path: string;
  filename: string;
  bytes: number;
  objectName: string;
  objectType: string;
  consumersFound: number;
}

export const documentObjectTool: CapituTool<typeof docSchema, DocumentObjectOutput> = {
  name: 'capituDevDocumentObject',
  description:
    'Read an ABAP/CDS object via ADT and generate a technical documentation .docx in capitu-output/documentation/. ' +
    'Includes header, full source code, and (by default) a where-used summary. Use when asked to "documentar" an object.',
  category: 'code-read',
  inputSchema: docSchema,
  handler: async (input, ctx): Promise<DocumentObjectOutput> => {
    // Source URI ends in /source/main; the object URI is the parent.
    const objectUri = input.sourceUri.replace(/\/source\/main\/?$/, '');
    const objectName = inferNameFromUri(objectUri);
    const objectType = inferTypeFromUri(objectUri);

    // 1. Read source
    const src = await ctx.adt.getSource(input.sourceUri);

    // 2. Optional where-used
    let consumers: Array<{
      uri: string;
      type: string;
      name: string;
      packageName?: string;
      description?: string;
    }> = [];
    if (input.includeWhereUsed) {
      try {
        const refs = await ctx.adt.findReferences(objectUri);
        consumers = refs.slice(0, input.whereUsedLimit);
      } catch {
        // best-effort; missing where-used is not fatal
      }
    }

    // 3. Try to enrich with package + description via search
    let description: string | undefined;
    let packageName: string | undefined;
    try {
      const adtTypeShort = objectType.split('/')[0] ?? '';
      const hits = await ctx.adt.search(objectName, adtTypeShort, 5);
      const exact = hits.find((h) => h.name.toUpperCase() === objectName.toUpperCase());
      if (exact) {
        description = exact.description;
        packageName = exact.packageName;
      }
    } catch {
      // skip
    }

    const md = buildDocumentationMarkdown({
      objectName,
      objectType,
      description,
      packageName,
      sourceUri: input.sourceUri,
      source: src.source,
      consumers,
    });

    const result = await writeMarkdownAsDocx({
      markdown: md,
      title: `${objectName} — Documentação Técnica`,
      category: 'documentation',
    });
    return {
      path: result.path,
      filename: result.filename,
      bytes: result.bytes,
      objectName,
      objectType,
      consumersFound: consumers.length,
    };
  },
};

function inferNameFromUri(uri: string): string {
  // /sap/bc/adt/ddic/ddl/sources/zi_test_capitu -> zi_test_capitu
  const parts = uri.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? '').toUpperCase();
}

function inferTypeFromUri(uri: string): string {
  if (uri.includes('/ddic/ddl/sources/')) return 'DDLS/DF';
  if (uri.includes('/oo/classes/')) return 'CLAS/OC';
  if (uri.includes('/oo/interfaces/')) return 'INTF/OI';
  if (uri.includes('/acm/dcl/sources/')) return 'DCLS/DL';
  if (uri.includes('/ddic/srvd/sources/')) return 'SRVD/SRV';
  if (uri.includes('/ddic/tables/')) return 'TABL/DT';
  if (uri.includes('/ddic/domains/')) return 'DOMA/DD';
  if (uri.includes('/ddic/dataelements/')) return 'DTEL/DE';
  if (uri.includes('/programs/programs/')) return 'PROG/P';
  if (uri.includes('/programs/includes/')) return 'PROG/I';
  return 'UNKNOWN';
}

function buildDocumentationMarkdown(args: {
  objectName: string;
  objectType: string;
  description?: string;
  packageName?: string;
  sourceUri: string;
  source: string;
  consumers: Array<{
    uri: string;
    type: string;
    name: string;
    packageName?: string;
    description?: string;
  }>;
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.objectName}`);
  lines.push('');
  lines.push('## Cabeçalho');
  lines.push('');
  lines.push('| Atributo | Valor |');
  lines.push('|----------|-------|');
  lines.push(`| Tipo | \`${args.objectType}\` |`);
  if (args.description) lines.push(`| Descrição | ${args.description} |`);
  if (args.packageName) lines.push(`| Pacote | \`${args.packageName}\` |`);
  lines.push(`| URI ADT | \`${args.sourceUri}\` |`);
  lines.push(`| Documentado em | ${new Date().toISOString()} |`);
  lines.push('');

  lines.push('## Código fonte');
  lines.push('');
  lines.push('```abap');
  lines.push(args.source.trim());
  lines.push('```');
  lines.push('');

  if (args.consumers.length === 0) {
    lines.push('## Consumidores');
    lines.push('');
    lines.push('_Nenhum consumidor encontrado via where-used. Este objeto está isolado — não é referenciado por outros._');
  } else {
    lines.push(`## Consumidores (${args.consumers.length})`);
    lines.push('');
    lines.push('| Tipo | Nome | Pacote | Descrição |');
    lines.push('|------|------|--------|-----------|');
    for (const c of args.consumers) {
      lines.push(
        `| \`${c.type}\` | \`${c.name}\` | ${c.packageName ? `\`${c.packageName}\`` : '—'} | ${c.description ?? ''} |`,
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Documento gerado por capitu-mcp / capituDevDocumentObject._');
  return lines.join('\n');
}
