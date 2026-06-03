/**
 * Pure regex search over ABAP source text — the "search" half of an agent's
 * "search → locate → read" loop, run server-side over ADT so the model gets
 * only matching lines + a little context instead of a full object source.
 *
 * Ported from ARC-1's `src/context/grep.ts` (idea + algorithm), trimmed to the
 * essentials we need now: no per-method annotation yet (that needs the class
 * structure parser — a follow-up). All functions are pure (no I/O); the tool
 * layer fetches the source and calls `grepSource`.
 */

export interface GrepOptions {
  /** Lines of context shown on each side of a match (default 3). */
  contextLines?: number;
  /** Cap on the number of matches rendered (default 100). */
  maxMatches?: number;
}

export interface GrepResult {
  /** Total matching lines found (before any maxMatches truncation). */
  matchCount: number;
  /** Formatted, LLM-friendly match report (or a no-match / invalid message). */
  output: string;
  /** True only when the pattern is invalid regex AND has no literal match either. */
  invalidPattern: boolean;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_MATCHES = 100;
const REGEX_META = /[.*+?^${}()|[\]\\]/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a `gim` regex, or null when the pattern is not valid regex. */
function tryCompile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'gim');
  } catch {
    return null;
  }
}

/** 0-based indexes of lines matching `regex` (resets lastIndex per line). */
function matchingIndexes(lines: string[], regex: RegExp): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    regex.lastIndex = 0;
    if (regex.test(lines[i] ?? '')) out.push(i);
  }
  return out;
}

/**
 * Resolve `pattern` against `lines`, falling back to a literal search so LLM
 * callers that forget to escape metacharacters (`a.b`, `read_entities(`) still
 * get results.
 */
function resolveMatches(
  lines: string[],
  pattern: string,
): { indexes: number[]; effectivePattern: string; invalidPattern: boolean } {
  const regex = tryCompile(pattern);
  if (regex) {
    const indexes = matchingIndexes(lines, regex);
    if (indexes.length > 0) return { indexes, effectivePattern: pattern, invalidPattern: false };
    // Valid regex, zero matches: an unescaped metachar may have been meant literally.
    if (REGEX_META.test(pattern)) {
      const literal = escapeRegex(pattern);
      const literalIndexes = matchingIndexes(lines, new RegExp(literal, 'gim'));
      if (literalIndexes.length > 0) {
        return { indexes: literalIndexes, effectivePattern: literal, invalidPattern: false };
      }
    }
    return { indexes: [], effectivePattern: pattern, invalidPattern: false };
  }
  // Not valid regex (e.g. an unbalanced paren): try it literally.
  const literal = escapeRegex(pattern);
  const literalRegex = tryCompile(literal);
  const literalIndexes = literalRegex ? matchingIndexes(lines, literalRegex) : [];
  if (literalIndexes.length > 0) {
    return { indexes: literalIndexes, effectivePattern: literal, invalidPattern: false };
  }
  return { indexes: [], effectivePattern: pattern, invalidPattern: true };
}

/**
 * Search `source` for `pattern`, returning matching lines + surrounding context
 * with 1-based line numbers. Case-insensitive; literal fallback on invalid regex.
 */
export function grepSource(source: string, pattern: string, opts: GrepOptions = {}): GrepResult {
  const contextLines = opts.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  const { indexes, effectivePattern, invalidPattern } = resolveMatches(lines, pattern);

  if (invalidPattern) {
    return {
      matchCount: 0,
      invalidPattern: true,
      output: `Invalid regex pattern: "${pattern}" (and no literal match). Escape regex metacharacters or send a simpler pattern.`,
    };
  }
  if (indexes.length === 0) {
    return {
      matchCount: 0,
      invalidPattern: false,
      output: `No matches found for /${effectivePattern}/i.`,
    };
  }

  const matchCount = indexes.length;
  const truncated = matchCount > maxMatches;
  const shown = truncated ? indexes.slice(0, maxMatches) : indexes;
  const matchSet = new Set(shown);

  // Union of match lines + their context windows.
  const visible = new Set<number>();
  for (const idx of shown) {
    for (
      let c = Math.max(0, idx - contextLines);
      c <= Math.min(lines.length - 1, idx + contextLines);
      c++
    ) {
      visible.add(c);
    }
  }
  const sorted = [...visible].sort((a, b) => a - b);

  const out: string[] = [`${matchCount} match(es) for /${effectivePattern}/i:`];
  let prevLine = -2;
  for (const idx of sorted) {
    // Non-contiguous block → visual separator.
    if (idx > prevLine + 1 && out.length > 1) out.push('--');
    const marker = matchSet.has(idx) ? '>' : ' ';
    out.push(`${marker}${String(idx + 1).padStart(5)}: ${lines[idx]}`);
    prevLine = idx;
  }
  if (truncated) {
    out.push(`\n... showing first ${maxMatches} of ${matchCount} matches. Narrow your pattern.`);
  }

  return { matchCount, invalidPattern: false, output: out.join('\n') };
}
