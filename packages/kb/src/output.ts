import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

/**
 * Resolves the capitu output directory based on env var or sensible defaults.
 *
 * Resolution order:
 *   1. CAPITU_OUTPUT_DIR env var (absolute path).
 *   2. <cwd>/capitu-output/  — the project-local default.
 *
 * Sub-categories are created lazily on first write. Each call to write* helpers
 * mkdir's the target subdir to keep the side-effect close to the action.
 */

export type OutputCategory = 'documentation' | 'specifications' | 'analysis';

const SUBDIRS: Record<OutputCategory, string> = {
  documentation: 'documentation',
  specifications: 'specifications',
  analysis: 'analysis',
};

export function resolveOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CAPITU_OUTPUT_DIR;
  if (fromEnv && fromEnv.trim()) {
    return resolve(fromEnv.trim());
  }
  return resolve(process.cwd(), 'capitu-output');
}

export function categoryDir(category: OutputCategory, base?: string): string {
  return join(base ?? resolveOutputDir(), SUBDIRS[category]);
}

/**
 * Build a filesystem-safe filename from a title.
 * Adds a UTC timestamp prefix (YYYY-MM-DD_HHMM) so artifacts sort chronologically.
 */
export function buildFilename(title: string, ext: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'untitled';
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${ts}_${slug}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

// ---- DOCX builder ----------------------------------------------------------

/**
 * Convert a small subset of markdown to a docx Document. Supports:
 *   - Headings (#, ##, ###, ####)
 *   - Tables (pipe-style)
 *   - Bullet lists (- or *)
 *   - Numbered lists (1.)
 *   - Inline code (`text`) and code fences (```...```)
 *   - Blockquotes (>)
 *   - Bold (**text**) and italic (*text*)
 *
 * Keeps style "technical clean": no cover page, no headers/footers, default
 * fonts. Tables get a thin border + bold header row.
 *
 * Anything we don't recognize falls through as plain paragraph — preserves
 * the original text rather than dropping it.
 */
export async function markdownToDocxBuffer(
  markdown: string,
  title: string,
): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  // Title at top
  children.push(
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 300 },
    }),
  );

  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Code fence
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i++;
      }
      i++; // skip closing fence
      for (const cl of codeLines) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: cl || ' ',
                font: 'Consolas',
                size: 18,
              }),
            ],
            spacing: { after: 40 },
          }),
        );
      }
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const level = (h[1] ?? '#').length;
      const text = h[2] ?? '';
      const heading =
        level === 1
          ? HeadingLevel.HEADING_1
          : level === 2
            ? HeadingLevel.HEADING_2
            : level === 3
              ? HeadingLevel.HEADING_3
              : HeadingLevel.HEADING_4;
      children.push(new Paragraph({ text, heading, spacing: { before: 200, after: 100 } }));
      i++;
      continue;
    }

    // Pipe table: a header line followed by separator line of dashes
    if (line.includes('|') && (lines[i + 1] ?? '').match(/^\s*\|?[\s|:-]+\|?\s*$/)) {
      const headerCells = splitTableRow(line);
      const rows: string[][] = [];
      i += 2; // skip header + separator
      while (i < lines.length && (lines[i] ?? '').includes('|')) {
        rows.push(splitTableRow(lines[i] ?? ''));
        i++;
      }
      children.push(buildTable(headerCells, rows));
      continue;
    }

    // Bullet list
    if (line.match(/^\s*[-*]\s+/)) {
      const item = line.replace(/^\s*[-*]\s+/, '');
      children.push(
        new Paragraph({
          children: inlineRuns(item),
          bullet: { level: 0 },
          spacing: { after: 40 },
        }),
      );
      i++;
      continue;
    }

    // Numbered list
    if (line.match(/^\s*\d+\.\s+/)) {
      const item = line.replace(/^\s*\d+\.\s+/, '');
      children.push(
        new Paragraph({
          children: inlineRuns(item),
          numbering: { reference: 'capitu-numbered', level: 0 },
          spacing: { after: 40 },
        }),
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quote = line.replace(/^>\s?/, '');
      children.push(
        new Paragraph({
          children: [new TextRun({ text: quote, italics: true })],
          indent: { left: 360 },
          spacing: { after: 60 },
        }),
      );
      i++;
      continue;
    }

    // Empty line → spacer
    if (line.trim() === '') {
      children.push(new Paragraph({ text: '' }));
      i++;
      continue;
    }

    // HR
    if (line.match(/^-{3,}$/)) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: '────────────────────────────', color: '888888' })],
          alignment: AlignmentType.CENTER,
        }),
      );
      i++;
      continue;
    }

    // Plain paragraph
    children.push(
      new Paragraph({ children: inlineRuns(line), spacing: { after: 80 } }),
    );
    i++;
  }

  const doc = new Document({
    creator: 'capitu-mcp',
    title,
    description: 'Generated by capitu-mcp',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'capitu-numbered',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 360, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

function buildTable(header: string[], rows: string[][]): Table {
  const widthPct = Math.floor(100 / Math.max(header.length, 1));
  const headerRow = new TableRow({
    tableHeader: true,
    children: header.map(
      (text) =>
        new TableCell({
          width: { size: widthPct, type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({
              children: [new TextRun({ text, bold: true })],
            }),
          ],
        }),
    ),
  });
  const bodyRows = rows.map(
    (cells) =>
      new TableRow({
        children: cells.map(
          (text) =>
            new TableCell({
              width: { size: widthPct, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: inlineRuns(text) })],
            }),
        ),
      }),
  );
  return new Table({
    rows: [headerRow, ...bodyRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

/**
 * Parse inline markdown: **bold**, *italic*, `code`.
 * Returns an array of TextRun children for a Paragraph.
 */
function inlineRuns(text: string): TextRun[] {
  if (!text) return [new TextRun({ text: '' })];
  const runs: TextRun[] = [];
  // Tokenize: find spans of `code`, **bold**, *italic*
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      runs.push(new TextRun({ text: text.slice(lastIdx, match.index) }));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      runs.push(
        new TextRun({ text: token.slice(1, -1), font: 'Consolas', size: 20 }),
      );
    } else if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    }
    lastIdx = match.index + token.length;
  }
  if (lastIdx < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIdx) }));
  }
  return runs;
}

// ---- File writes -----------------------------------------------------------

export interface WriteResult {
  path: string;
  bytes: number;
  category: OutputCategory;
  filename: string;
}

export async function writeMarkdownAsDocx(args: {
  markdown: string;
  title: string;
  category: OutputCategory;
  filename?: string;
  baseDir?: string;
}): Promise<WriteResult> {
  const dir = categoryDir(args.category, args.baseDir);
  mkdirSync(dir, { recursive: true });
  const name = args.filename ?? buildFilename(args.title, '.docx');
  const fullPath = join(dir, name);
  const buf = await markdownToDocxBuffer(args.markdown, args.title);
  writeFileSync(fullPath, buf);
  return { path: fullPath, bytes: buf.length, category: args.category, filename: name };
}

export function writeMarkdownAsMd(args: {
  markdown: string;
  title: string;
  category: OutputCategory;
  filename?: string;
  baseDir?: string;
}): WriteResult {
  const dir = categoryDir(args.category, args.baseDir);
  mkdirSync(dir, { recursive: true });
  const name = args.filename ?? buildFilename(args.title, '.md');
  const fullPath = join(dir, name);
  writeFileSync(fullPath, args.markdown, 'utf8');
  const stat = statSync(fullPath);
  return { path: fullPath, bytes: stat.size, category: args.category, filename: name };
}

// ---- Listing ---------------------------------------------------------------

export interface OutputListing {
  baseDir: string;
  byCategory: Record<OutputCategory, Array<{ filename: string; bytes: number; modifiedAt: string }>>;
}

export function listOutputs(baseDir?: string): OutputListing {
  const dir = baseDir ?? resolveOutputDir();
  const out: OutputListing = {
    baseDir: dir,
    byCategory: { documentation: [], specifications: [], analysis: [] },
  };
  for (const cat of Object.keys(SUBDIRS) as OutputCategory[]) {
    const subdir = categoryDir(cat, dir);
    try {
      const entries = readdirSync(subdir);
      for (const entry of entries) {
        const full = join(subdir, entry);
        try {
          const st = statSync(full);
          if (st.isFile()) {
            out.byCategory[cat].push({
              filename: entry,
              bytes: st.size,
              modifiedAt: st.mtime.toISOString(),
            });
          }
        } catch {
          // skip unreadable entries
        }
      }
      out.byCategory[cat].sort((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1));
    } catch {
      // subdir doesn't exist yet — empty list
    }
  }
  return out;
}

// helper to ensure baseDir exists (used by smoke tests / setup scripts)
export function ensureOutputDirsExist(baseDir?: string): string {
  const dir = baseDir ?? resolveOutputDir();
  for (const cat of Object.keys(SUBDIRS) as OutputCategory[]) {
    mkdirSync(categoryDir(cat, dir), { recursive: true });
  }
  return dir;
}

export { dirname };
