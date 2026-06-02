import type { CapituAdtClient } from '@capitu/adt-client';

/**
 * Resolves the real column names of a CDS view by reading its source via ADT
 * and parsing the select list. Used by capituSpecPropose to replace
 * <SOURCE_FIELD> placeholders with actual columns when possible.
 *
 * Strategy:
 *  1. Search the basedOn name as DDLS to find the URI.
 *  2. Read the source via /source/main.
 *  3. Parse the select-list using a deliberately conservative regex —
 *     CDS syntax is rich and we won't reimplement the parser. We extract
 *     identifiers from inside the {...} block, normalize, and return.
 *  4. Match each requested alias against the extracted columns:
 *     - exact match (case-insensitive)
 *     - snake_case <-> CamelCase conversion
 *     - if no match, return placeholder and add a warning
 */

export interface FieldMatch {
  alias: string;
  source: string | null; // null when no match
  matchType: 'exact' | 'case-insensitive' | 'snake-camel' | 'placeholder';
}

export interface ResolvedFields {
  baseName: string;
  baseColumns: string[];
  matches: FieldMatch[];
  warnings: string[];
}

export async function resolveFieldsForArtifact(
  adt: CapituAdtClient,
  basedOn: string,
  exposes: string[],
): Promise<ResolvedFields | null> {
  if (!basedOn || exposes.length === 0) return null;

  // Skip if basedOn isn't a name we can look up (e.g. /dmo/ tables, custom paths)
  if (basedOn.startsWith('/')) {
    // Tables (DBT) — we still try, but search by type TABL
    return await resolveFromTable(adt, basedOn, exposes);
  }

  // Try CDS DDLS first
  return await resolveFromCds(adt, basedOn, exposes);
}

async function resolveFromCds(
  adt: CapituAdtClient,
  basedOn: string,
  exposes: string[],
): Promise<ResolvedFields | null> {
  const warnings: string[] = [];

  // 1. Locate the object via search
  let sourceUri: string;
  try {
    const hits = await adt.search(basedOn, 'DDLS', 5);
    const exact = hits.find((h) => h.name.toUpperCase() === basedOn.toUpperCase());
    if (!exact) {
      warnings.push(`Could not locate ${basedOn} as CDS via search; field resolution skipped.`);
      return {
        baseName: basedOn,
        baseColumns: [],
        matches: defaultPlaceholders(exposes),
        warnings,
      };
    }
    sourceUri = `${exact.uri}/source/main`;
  } catch (err) {
    warnings.push(
      `Search failed for ${basedOn}: ${err instanceof Error ? err.message : err}. Field resolution skipped.`,
    );
    return { baseName: basedOn, baseColumns: [], matches: defaultPlaceholders(exposes), warnings };
  }

  // 2. Read source and parse
  let source: string;
  try {
    const obj = await adt.getSource(sourceUri);
    source = obj.source;
  } catch (err) {
    warnings.push(`getSource failed for ${basedOn}: ${err instanceof Error ? err.message : err}.`);
    return { baseName: basedOn, baseColumns: [], matches: defaultPlaceholders(exposes), warnings };
  }

  const baseColumns = extractCdsColumns(source);
  if (baseColumns.length === 0) {
    warnings.push(
      `Parsed source of ${basedOn} but no columns extracted. The view may have unusual structure.`,
    );
  }

  // 3. Match each exposed alias
  const matches = exposes.map((alias) => matchField(alias, baseColumns));
  for (const m of matches) {
    if (m.matchType === 'placeholder') {
      warnings.push(
        `Could not match alias "${m.alias}" in columns of ${basedOn}. Replace <SOURCE_FIELD> manually.`,
      );
    }
  }

  return { baseName: basedOn, baseColumns, matches, warnings };
}

async function resolveFromTable(
  _adt: CapituAdtClient,
  basedOn: string,
  exposes: string[],
): Promise<ResolvedFields | null> {
  // For /dmo/* etc. we can't easily parse table structure from ADT source
  // (tables are XML). For now we return placeholders and warn.
  // The adt client is intentionally unused — future work: hit /sap/bc/adt/ddic/tables/<name>
  // and parse the field list from there.
  return {
    baseName: basedOn,
    baseColumns: [],
    matches: defaultPlaceholders(exposes),
    warnings: [
      `Field resolution from raw tables like ${basedOn} not yet supported. <SOURCE_FIELD> placeholders kept; replace manually with actual column names (e.g. carrier_id, booking_id).`,
    ],
  };
}

function defaultPlaceholders(exposes: string[]): FieldMatch[] {
  return exposes.map((alias) => ({
    alias,
    source: null,
    matchType: 'placeholder' as const,
  }));
}

/**
 * Extracts column identifiers from a CDS source by isolating the select-block
 * {...} and stripping comments + 'as Alias' suffixes.
 *
 * Best-effort parser: we look for the first balanced { ... } that comes after
 * 'select from'. Inside, each comma-separated entry is a column reference.
 * For each entry, the leftmost identifier (before 'as', 'AS' or whitespace
 * followed by another identifier) is the source column name.
 */
export function extractCdsColumns(source: string): string[] {
  // Strip line/block comments first
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  const lower = noLineComments.toLowerCase();
  const selectIdx = lower.indexOf('select from');
  if (selectIdx < 0) {
    // Maybe extension view or projection — try just looking for first {
    return parseSelectBlock(noLineComments, 0);
  }
  return parseSelectBlock(noLineComments, selectIdx);
}

function parseSelectBlock(text: string, startFrom: number): string[] {
  const openIdx = text.indexOf('{', startFrom);
  if (openIdx < 0) return [];
  // Find matching close brace
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return [];

  const block = text.slice(openIdx + 1, closeIdx);
  // Split by commas, but respect nested () e.g. cast(...)
  const entries = splitTopLevel(block, ',');

  const columns: string[] = [];
  for (let raw of entries) {
    raw = raw.trim();
    if (!raw) continue;
    // Strip leading 'key '
    raw = raw.replace(/^key\s+/i, '');
    // Strip leading @<Annotation>: <Value> ... blocks
    raw = raw.replace(/^@[\w.]+:\s*[^\n]*\n?/g, '').trim();
    // The source column is the first identifier-like token
    const firstToken = raw.match(/[A-Za-z_/][\w/.]*/)?.[0];
    if (firstToken) {
      // Skip ABAP keywords that aren't columns (rare in CDS select lists)
      const upper = firstToken.toUpperCase();
      if (
        upper !== 'CAST' &&
        upper !== 'CASE' &&
        upper !== 'COALESCE' &&
        !columns.includes(firstToken)
      ) {
        columns.push(firstToken);
      }
    }
  }
  return columns;
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

export function matchField(alias: string, columns: string[]): FieldMatch {
  // 1. exact
  const exact = columns.find((c) => c === alias);
  if (exact) return { alias, source: exact, matchType: 'exact' };
  // 2. case-insensitive
  const ci = columns.find((c) => c.toLowerCase() === alias.toLowerCase());
  if (ci) return { alias, source: ci, matchType: 'case-insensitive' };
  // 3. snake_case <-> CamelCase
  const aliasSnake = camelToSnake(alias);
  const aliasCamel = snakeToCamel(alias);
  const snakeMatch = columns.find(
    (c) => c.toLowerCase() === aliasSnake.toLowerCase() || c === aliasCamel,
  );
  if (snakeMatch) return { alias, source: snakeMatch, matchType: 'snake-camel' };
  // 4. placeholder
  return { alias, source: null, matchType: 'placeholder' };
}

function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
