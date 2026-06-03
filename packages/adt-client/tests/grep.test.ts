import { describe, expect, it } from 'vitest';
import { grepSource } from '../src/grep.js';

const SAMPLE = [
  'CLASS zcl_order DEFINITION PUBLIC.',
  '  PUBLIC SECTION.',
  '    METHODS create IMPORTING order TYPE ty_order.',
  '    METHODS read_entities.',
  'ENDCLASS.',
  'CLASS zcl_order IMPLEMENTATION.',
  '  METHOD create.',
  '    DATA(lo) = NEW zcl_helper( ).',
  '    lo->read_entities( ).',
  '  ENDMETHOD.',
  'ENDCLASS.',
].join('\n');

describe('grepSource', () => {
  it('finds a simple case-insensitive match with context', () => {
    const r = grepSource(SAMPLE, 'new zcl_helper', { contextLines: 1 });
    expect(r.matchCount).toBe(1);
    expect(r.invalidPattern).toBe(false);
    expect(r.output).toMatch(/NEW zcl_helper/);
    // 1-based line number of the match line (8)
    expect(r.output).toMatch(/>\s*8: /);
  });

  it('returns multiple matches', () => {
    const r = grepSource(SAMPLE, 'read_entities');
    expect(r.matchCount).toBe(2); // declaration + call
  });

  it('falls back to literal search for an unescaped paren', () => {
    // "read_entities(" is invalid regex (unbalanced paren) → literal fallback.
    const r = grepSource(SAMPLE, 'read_entities(');
    expect(r.invalidPattern).toBe(false);
    expect(r.matchCount).toBe(1); // only the call site has the "("
    expect(r.output).toMatch(/lo->read_entities\( \)/);
  });

  it('falls back to literal when a metachar regex has zero matches', () => {
    // "zcl_order." is valid regex (. = any char) and DOES match, so to force the
    // literal path we use a pattern whose regex form matches nothing but literal does.
    const r = grepSource('a+b = c', 'a+b');
    expect(r.matchCount).toBe(1);
    expect(r.output).toMatch(/a\+b/);
  });

  it('reports no matches cleanly', () => {
    const r = grepSource(SAMPLE, 'zzz_nonexistent');
    expect(r.matchCount).toBe(0);
    expect(r.invalidPattern).toBe(false);
    expect(r.output).toMatch(/No matches/);
  });

  it('caps the number of matches and says so', () => {
    const many = Array.from({ length: 10 }, (_, i) => `line ${i} foo`).join('\n');
    const r = grepSource(many, 'foo', { maxMatches: 3, contextLines: 0 });
    expect(r.matchCount).toBe(10);
    expect(r.output).toMatch(/showing first 3 of 10/);
  });

  it('tolerates CRLF source', () => {
    const crlf = 'METHOD a.\r\n  WRITE foo.\r\nENDMETHOD.';
    const r = grepSource(crlf, 'write foo', { contextLines: 0 });
    expect(r.matchCount).toBe(1);
    expect(r.output).toMatch(/WRITE foo/);
  });

  it('emits separators between non-contiguous blocks', () => {
    const r = grepSource(SAMPLE, 'CLASS', { contextLines: 0 });
    expect(r.matchCount).toBe(4); // 2 DEFINITION + 2 IMPLEMENTATION lines contain "CLASS"
    expect(r.output).toContain('--');
  });
});
