/**
 * Method-level surgery for ABAP classes.
 *
 * Why this module exists:
 *  - Rewriting an entire ABAP class (`capituDevWriteObject`) costs roughly
 *    one LLM token per source character. Classes routinely cross 5k tokens.
 *  - Most edits target one method. A method usually has 20-200 LoC.
 *  - Extracting and rewriting just the method drops the LLM payload to ~1/10th
 *    while preserving the rest of the file byte-for-byte.
 *
 * Adoption notes from ARC-1 (researched 2026-05-20):
 *  - Class-local includes (CCDEF / CCIMP / CCAU) carry one or more `lhc_*`
 *    or `lcl_*` classes — a bare `METHOD foo. ... ENDMETHOD.` can appear in
 *    multiple containing classes. Always disambiguate by the `lcl_class~method`
 *    qualified form when the bare name resolves to more than one match.
 *  - Method name comparison is case-insensitive (ABAP is case-insensitive).
 *  - The string `METHOD` / `ENDMETHOD` must be at statement boundary —
 *    naively matching it can collide with comments and string literals.
 *    We strip line comments and triple-quoted text before parsing.
 */

export type IncludeKind = 'main' | 'definitions' | 'implementations' | 'testclasses' | 'macros';

export interface MethodMatch {
  /** Class that contains the method (lhc_booking, lcl_helper, ZCL_X, ...). null when global. */
  containingClass: string | null;
  /** Method name as it appears in the source. */
  name: string;
  /** Offset of the `METHOD` keyword. */
  startOffset: number;
  /** Offset right after `ENDMETHOD.` (and trailing newline if any). */
  endOffset: number;
  /** Body content between `METHOD ...` line and `ENDMETHOD.` — no leading/trailing newline. */
  body: string;
  /** Full METHOD…ENDMETHOD block (used for snapshotting). */
  block: string;
}

export interface ParseOptions {
  /** When set, only match methods in this containing local class. */
  containingClass?: string;
}

/**
 * Locate every `METHOD <name>. ... ENDMETHOD.` block in a source.
 *
 * The parser is intentionally minimal — it leans on ABAP's predictable
 * keyword shape. Edge cases the regex layer handles:
 *  - Mixed-case METHOD / EndMethod / Method (ABAP is case-insensitive)
 *  - Optional final period after ENDMETHOD (ABAP requires it; we tolerate both)
 *  - Body that contains the string "method" inside a quoted literal (lowered
 *    via comment-strip pre-pass, but we still anchor on line-start)
 */
export function findAllMethods(source: string, opts: ParseOptions = {}): MethodMatch[] {
  const stripped = stripLineCommentsAndStringNoise(source);
  const matches: MethodMatch[] = [];

  // Track containing CLASS ... IMPLEMENTATION so we know where each METHOD lives.
  // Regex captures the local class name from `CLASS lhc_booking IMPLEMENTATION.`
  const classRe =
    /(?:^|\n)\s*CLASS\s+([a-zA-Z_][\w/]*)\s+IMPLEMENTATION\b[\s\S]*?(?=(?:\n\s*ENDCLASS\b)|$)/gi;
  const classRanges: Array<{ name: string; start: number; end: number }> = [];
  for (const m of stripped.matchAll(classRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    classRanges.push({ name: (m[1] ?? '').toLowerCase(), start, end });
  }

  // Method blocks: greedy until ENDMETHOD. (with optional final period)
  // The body is captured between the first newline after `METHOD name.` and ENDMETHOD.
  const methodRe =
    /(?:^|\n)(\s*)METHOD\s+([a-zA-Z_][\w~/]*)\s*\.\s*\n([\s\S]*?)\n\s*ENDMETHOD\s*\.?/gi;
  for (const m of stripped.matchAll(methodRe)) {
    const startOffset = (m.index ?? 0) + (m[0].startsWith('\n') ? 1 : 0);
    const endOffset = startOffset + m[0].length - (m[0].startsWith('\n') ? 1 : 0);
    const name = m[2] ?? '';
    const body = m[3] ?? '';
    const containingClass = findContainingClass(startOffset, classRanges);

    if (
      opts.containingClass &&
      containingClass?.toLowerCase() !== opts.containingClass.toLowerCase()
    ) {
      continue;
    }
    matches.push({
      containingClass,
      name,
      startOffset,
      endOffset,
      body,
      block: source.slice(startOffset, endOffset),
    });
  }
  return matches;
}

function findContainingClass(
  offset: number,
  ranges: Array<{ name: string; start: number; end: number }>,
): string | null {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) return r.name;
  }
  return null;
}

/**
 * Strip ABAP line comments (`*` at column 0 OR `"` mid-line) and replace
 * single-line string literals with placeholder spaces of the same length.
 * Preserves byte offsets so downstream regex matches still index correctly
 * into the original string.
 *
 * This is good enough to keep `METHOD` / `ENDMETHOD` parsing honest without
 * pulling in @abaplint just for the parser.
 */
function stripLineCommentsAndStringNoise(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    // `*` at start of line = full-line comment in ABAP
    if (/^\s*\*/.test(raw)) {
      out.push(' '.repeat(raw.length));
      continue;
    }
    // Inline `"` comment — keep code up to the `"`, blank the rest
    let stripped = raw;
    let depth = 0;
    let cutAt = -1;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === "'") {
        // toggle single-quote string state
        depth = depth === 0 ? 1 : 0;
        continue;
      }
      if (ch === '`') {
        depth = depth === 0 ? 1 : 0;
        continue;
      }
      if (ch === '"' && depth === 0) {
        cutAt = i;
        break;
      }
    }
    if (cutAt >= 0) {
      stripped = stripped.slice(0, cutAt) + ' '.repeat(stripped.length - cutAt);
    }
    out.push(stripped);
  }
  return out.join('\n');
}

export class MethodSurgeryError extends Error {
  constructor(
    message: string,
    public readonly code: 'METHOD_NOT_FOUND' | 'AMBIGUOUS_METHOD' | 'INVALID_QUALIFIED_NAME',
  ) {
    super(message);
    this.name = 'MethodSurgeryError';
  }
}

export interface SpliceResult {
  newSource: string;
  oldBlock: string;
  newBlock: string;
  match: MethodMatch;
}

/**
 * Replace the body of a method in-place. Returns the new full source AND the
 * old block (so the caller can snapshot for rollback / audit).
 *
 * Resolution rules (mirrors ARC-1's lookup order):
 *  1. If `methodName` is qualified (`lcl_foo~bar`), match exactly.
 *  2. If bare and exactly one method has that name in the file → use it.
 *  3. If bare and multiple matches across different containing classes →
 *     throw AMBIGUOUS_METHOD and list the candidates.
 *  4. If no match → throw METHOD_NOT_FOUND.
 */
export function spliceMethodBody(
  source: string,
  methodName: string,
  newBody: string,
): SpliceResult {
  let containing: string | undefined;
  let bare = methodName;
  if (methodName.includes('~')) {
    const parts = methodName.split('~');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new MethodSurgeryError(
        `Invalid qualified method name "${methodName}". Use "lcl_class~method_name".`,
        'INVALID_QUALIFIED_NAME',
      );
    }
    containing = parts[0];
    bare = parts[1];
  }

  const all = findAllMethods(source, containing ? { containingClass: containing } : {});
  const byBare = all.filter((m) => m.name.toLowerCase() === bare.toLowerCase());

  if (byBare.length === 0) {
    const list =
      all.map((m) => `${m.containingClass ?? '(global)'}~${m.name}`).join(', ') || '(none)';
    throw new MethodSurgeryError(
      `Method "${methodName}" not found. Available: ${list}`,
      'METHOD_NOT_FOUND',
    );
  }
  if (byBare.length > 1 && !containing) {
    const list = byBare.map((m) => `${m.containingClass ?? '(global)'}~${m.name}`).join(', ');
    throw new MethodSurgeryError(
      `Method "${methodName}" is ambiguous — found in ${byBare.length} classes: ${list}. ` +
        `Use the qualified form "lcl_class~${bare}" to disambiguate.`,
      'AMBIGUOUS_METHOD',
    );
  }

  const match = byBare[0];
  if (!match) {
    // Defensive — should be impossible because we just checked length > 0
    throw new MethodSurgeryError(
      `Method "${methodName}" not found after filtering.`,
      'METHOD_NOT_FOUND',
    );
  }

  // Build the new block. Preserve the original METHOD line and the indent
  // of the ENDMETHOD line.
  const blockLines = match.block.split('\n');
  const methodLine = blockLines[0] ?? `METHOD ${match.name}.`;
  // Trim trailing line break, then re-add to ensure clean formatting.
  const normalizedBody = newBody.replace(/^\n+/, '').replace(/\n+$/, '');
  // Detect indent of ENDMETHOD (last line of block typically).
  const endLine = blockLines[blockLines.length - 1] ?? '  ENDMETHOD.';
  const newBlock = `${methodLine}\n${normalizedBody}\n${endLine}`;

  const newSource = source.slice(0, match.startOffset) + newBlock + source.slice(match.endOffset);

  return {
    newSource,
    oldBlock: match.block,
    newBlock,
    match,
  };
}

/**
 * Infer which class-include the method most likely lives in, from its prefix.
 * Caller can override; this is just a sensible default for `auto` mode.
 *
 *  - `lhc_*` / `lcl_*`           → implementations (CCIMP)
 *  - `ltc_*`                     → testclasses    (CCAU)
 *  - `lif_*`, `zif_*~method`, …  → main           (the global class body)
 *  - bare name (no qualifier)    → main
 */
export function inferIncludeKind(methodName: string): IncludeKind {
  const lower = methodName.toLowerCase();
  if (lower.startsWith('lhc_') || (lower.includes('~') && lower.startsWith('lhc_'))) {
    return 'implementations';
  }
  if (lower.startsWith('lcl_')) return 'implementations';
  if (lower.startsWith('ltc_')) return 'testclasses';
  return 'main';
}

/**
 * Build the ADT source URI for a specific class include.
 *
 * Layout matches ARC-1's `classIncludeUrlFor` in `arc-1/src/adt/rap-generate.ts`,
 * confirmed against live S/4HANA `objectStructure` (the `<abapsource:sourceUri>`
 * element for each include returns `includes/<kind>` — NOT `includes/<kind>/source/main`).
 *
 *   main           → <classObjectUri>/source/main
 *   definitions    → <classObjectUri>/includes/definitions
 *   implementations→ <classObjectUri>/includes/implementations
 *   testclasses    → <classObjectUri>/includes/testclasses
 *   macros         → <classObjectUri>/includes/macros
 *
 * Earlier versions of this helper appended `/source/main` to includes too, which
 * worked on NW 7.5x sandboxes (the ADT there silently accepted both forms) but
 * 404'd on S/4HANA PCE. The shorter form works on both.
 */
export function classIncludeUri(classObjectUri: string, include: IncludeKind): string {
  const cleaned = classObjectUri.replace(/\/+$/, '');
  switch (include) {
    case 'main':
      return `${cleaned}/source/main`;
    case 'definitions':
      return `${cleaned}/includes/definitions`;
    case 'implementations':
      return `${cleaned}/includes/implementations`;
    case 'testclasses':
      return `${cleaned}/includes/testclasses`;
    case 'macros':
      return `${cleaned}/includes/macros`;
  }
}
