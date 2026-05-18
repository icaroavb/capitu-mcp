import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFilename,
  categoryDir,
  listOutputs,
  markdownToDocxBuffer,
  resolveOutputDir,
  writeMarkdownAsDocx,
  writeMarkdownAsMd,
} from '../src/output.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'capitu-output-test-'));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore windows lock
  }
});

describe('resolveOutputDir', () => {
  it('honors CAPITU_OUTPUT_DIR when set', () => {
    expect(resolveOutputDir({ CAPITU_OUTPUT_DIR: tmpRoot })).toContain(
      tmpRoot.split('\\').pop() ?? tmpRoot.split('/').pop() ?? '',
    );
  });

  it('defaults to <cwd>/capitu-output when env not set', () => {
    const out = resolveOutputDir({});
    expect(out).toMatch(/capitu-output$/);
  });
});

describe('buildFilename', () => {
  it('produces timestamped slug with the right extension', () => {
    const name = buildFilename('Hello World!', '.docx');
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}_Hello_World\.docx$/);
  });

  it('handles dot in extension', () => {
    const name = buildFilename('x', 'md');
    expect(name.endsWith('.md')).toBe(true);
  });

  it('falls back to "untitled" when title is empty after sanitization', () => {
    const name = buildFilename('!!!', '.docx');
    expect(name).toMatch(/untitled\.docx$/);
  });
});

describe('markdownToDocxBuffer', () => {
  it('produces a non-empty buffer', async () => {
    const buf = await markdownToDocxBuffer('# Hello\n\nWorld', 'Hello');
    expect(buf.length).toBeGreaterThan(1000); // .docx has min overhead
  });

  it('renders tables, lists, code fences without throwing', async () => {
    const md = `# Title

Intro paragraph with **bold** and *italic* and \`code\`.

## Table

| A | B |
|---|---|
| 1 | 2 |

## List

- one
- two

## Code

\`\`\`abap
DATA lt TYPE STANDARD TABLE OF spfli.
\`\`\`
`;
    const buf = await markdownToDocxBuffer(md, 'Title');
    expect(buf.length).toBeGreaterThan(0);
  });
});

describe('writeMarkdownAsDocx + listOutputs', () => {
  it('writes a docx, creates the subdir, and lists it', async () => {
    const r = await writeMarkdownAsDocx({
      markdown: '# Test',
      title: 'My Doc',
      category: 'documentation',
      baseDir: tmpRoot,
    });
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toContain('documentation');
    expect(r.bytes).toBeGreaterThan(0);

    const listing = listOutputs(tmpRoot);
    expect(listing.byCategory.documentation).toHaveLength(1);
    expect(listing.byCategory.documentation[0]?.filename).toBe(r.filename);
  });

  it('writeMarkdownAsMd writes plain markdown', () => {
    const r = writeMarkdownAsMd({
      markdown: '# Title\n\nbody',
      title: 'Plain',
      category: 'analysis',
      baseDir: tmpRoot,
    });
    expect(existsSync(r.path)).toBe(true);
    const content = readFileSync(r.path, 'utf8');
    expect(content).toBe('# Title\n\nbody');
  });

  it('categoryDir returns the right subdirectory', () => {
    expect(categoryDir('specifications', tmpRoot)).toBe(join(tmpRoot, 'specifications'));
  });

  it('listOutputs returns empty arrays when directories do not exist', () => {
    const listing = listOutputs(tmpRoot);
    expect(listing.byCategory.documentation).toEqual([]);
    expect(listing.byCategory.specifications).toEqual([]);
    expect(listing.byCategory.analysis).toEqual([]);
  });
});
