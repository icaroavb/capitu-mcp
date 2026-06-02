import { describe, expect, it } from 'vitest';
import {
  MethodSurgeryError,
  classIncludeUri,
  findAllMethods,
  inferIncludeKind,
  spliceMethodBody,
} from '../src/method-surgery.js';

const GLOBAL_CLASS_SOURCE = `CLASS zcl_my_class DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS do_something.
    METHODS calculate IMPORTING iv_x TYPE i RETURNING VALUE(rv_y) TYPE i.
ENDCLASS.

CLASS zcl_my_class IMPLEMENTATION.
  METHOD do_something.
    DATA lv_msg TYPE string.
    lv_msg = 'hello'.
    WRITE: / lv_msg.
  ENDMETHOD.

  METHOD calculate.
    rv_y = iv_x * 2.
  ENDMETHOD.
ENDCLASS.
`;

const RAP_HANDLER_SOURCE = `CLASS lhc_booking DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS validate FOR VALIDATE ON SAVE IMPORTING keys FOR Booking~validate.
    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION.
ENDCLASS.

CLASS lhc_booking IMPLEMENTATION.
  METHOD validate.
    LOOP AT keys INTO DATA(key).
      " validation logic
    ENDLOOP.
  ENDMETHOD.

  METHOD get_global_authorizations.
    READ ENTITIES OF zi_booking IN LOCAL MODE
      ENTITY Booking ALL FIELDS WITH CORRESPONDING #( keys )
      RESULT DATA(result).
  ENDMETHOD.
ENDCLASS.

CLASS lhc_passenger DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS validate FOR VALIDATE ON SAVE IMPORTING keys FOR Passenger~validate.
ENDCLASS.

CLASS lhc_passenger IMPLEMENTATION.
  METHOD validate.
    " passenger validation
  ENDMETHOD.
ENDCLASS.
`;

describe('findAllMethods', () => {
  it('finds methods in a single global class', () => {
    const methods = findAllMethods(GLOBAL_CLASS_SOURCE);
    expect(methods.map((m) => m.name)).toEqual(['do_something', 'calculate']);
    expect(methods[0]?.containingClass).toBe('zcl_my_class');
    expect(methods[0]?.body).toContain("lv_msg = 'hello'");
  });

  it('finds methods across multiple local classes', () => {
    const methods = findAllMethods(RAP_HANDLER_SOURCE);
    const names = methods.map((m) => `${m.containingClass}~${m.name}`);
    expect(names).toContain('lhc_booking~validate');
    expect(names).toContain('lhc_booking~get_global_authorizations');
    expect(names).toContain('lhc_passenger~validate');
  });

  it('filters by containing class', () => {
    const methods = findAllMethods(RAP_HANDLER_SOURCE, { containingClass: 'lhc_passenger' });
    expect(methods).toHaveLength(1);
    expect(methods[0]?.name).toBe('validate');
  });

  it('ignores commented-out METHOD keywords', () => {
    const source = `CLASS zcl_x IMPLEMENTATION.
  METHOD foo.
    " METHOD inside comment.
    DATA lv_x TYPE i.
  ENDMETHOD.
ENDCLASS.`;
    const methods = findAllMethods(source);
    expect(methods).toHaveLength(1);
    expect(methods[0]?.name).toBe('foo');
  });

  it('is case-insensitive on the METHOD keyword', () => {
    const source = `CLASS zcl_x IMPLEMENTATION.
  Method Foo.
    DATA lv_x TYPE i.
  EndMethod.
ENDCLASS.`;
    const methods = findAllMethods(source);
    expect(methods).toHaveLength(1);
    expect(methods[0]?.name).toBe('Foo');
  });
});

describe('spliceMethodBody', () => {
  it('replaces a single method body and leaves the rest intact', () => {
    const result = spliceMethodBody(GLOBAL_CLASS_SOURCE, 'calculate', '    rv_y = iv_x * 10.');
    expect(result.newSource).toContain('rv_y = iv_x * 10.');
    expect(result.newSource).not.toContain('rv_y = iv_x * 2.');
    // do_something must be untouched
    expect(result.newSource).toContain("lv_msg = 'hello'");
    expect(result.oldBlock).toContain('rv_y = iv_x * 2.');
  });

  it('throws METHOD_NOT_FOUND for unknown method name', () => {
    expect(() =>
      spliceMethodBody(GLOBAL_CLASS_SOURCE, 'missing_method', 'data lv_x type i.'),
    ).toThrowError(MethodSurgeryError);
  });

  it('throws AMBIGUOUS_METHOD when bare name matches multiple classes', () => {
    try {
      spliceMethodBody(RAP_HANDLER_SOURCE, 'validate', '"new body"');
      throw new Error('expected splice to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MethodSurgeryError);
      expect((err as MethodSurgeryError).code).toBe('AMBIGUOUS_METHOD');
      expect((err as Error).message).toMatch(/ambiguous/i);
    }
  });

  it('resolves with qualified name when bare is ambiguous', () => {
    const result = spliceMethodBody(
      RAP_HANDLER_SOURCE,
      'lhc_passenger~validate',
      '    " new passenger validation logic\n    DATA lv_dummy TYPE i.',
    );
    expect(result.newSource).toContain('new passenger validation logic');
    // The other validate (lhc_booking) must still have its original body
    expect(result.newSource).toContain('LOOP AT keys INTO DATA(key).');
  });

  it('rejects malformed qualified names', () => {
    for (const bad of ['~validate', 'lhc_booking~']) {
      try {
        spliceMethodBody(RAP_HANDLER_SOURCE, bad, 'x');
        throw new Error(`expected splice to throw for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(MethodSurgeryError);
        expect((err as MethodSurgeryError).code).toBe('INVALID_QUALIFIED_NAME');
      }
    }
  });

  it('preserves the original METHOD signature line', () => {
    const source = `CLASS zcl_x IMPLEMENTATION.
  METHOD calculate.
    rv_y = iv_x + 1.
  ENDMETHOD.
ENDCLASS.`;
    const result = spliceMethodBody(source, 'calculate', '    rv_y = iv_x * 2.');
    // The METHOD declaration line must remain
    expect(result.newSource).toMatch(/METHOD calculate\.\s*\n/);
  });
});

describe('inferIncludeKind', () => {
  it('routes lhc_* and lcl_* to implementations', () => {
    expect(inferIncludeKind('lhc_booking~validate')).toBe('implementations');
    expect(inferIncludeKind('lcl_helper~do_thing')).toBe('implementations');
  });

  it('routes ltc_* to testclasses', () => {
    expect(inferIncludeKind('ltc_booking~test_create')).toBe('testclasses');
  });

  it('routes bare names and global interfaces to main', () => {
    expect(inferIncludeKind('do_something')).toBe('main');
    expect(inferIncludeKind('zif_handler~execute')).toBe('main');
  });
});

describe('classIncludeUri', () => {
  it('produces the right ADT path per include kind', () => {
    const base = '/sap/bc/adt/oo/classes/zcl_my_class';
    // main keeps /source/main — that's how the ADT serves the main source.
    expect(classIncludeUri(base, 'main')).toBe(`${base}/source/main`);
    // Class-local includes do NOT take /source/main on S/4HANA. The shorter
    // path is what abapsource:sourceUri returns in objectStructure, and it's
    // what ARC-1's classIncludeUrlFor produces. Verified live on PCE
    // (writing main+CCIMP with the long form 404'd; with the short form
    // succeeded).
    expect(classIncludeUri(base, 'definitions')).toBe(`${base}/includes/definitions`);
    expect(classIncludeUri(base, 'implementations')).toBe(`${base}/includes/implementations`);
    expect(classIncludeUri(base, 'testclasses')).toBe(`${base}/includes/testclasses`);
    expect(classIncludeUri(base, 'macros')).toBe(`${base}/includes/macros`);
  });

  it('strips trailing slashes on the object URI', () => {
    expect(classIncludeUri('/sap/bc/adt/oo/classes/zcl_x/', 'main')).toBe(
      '/sap/bc/adt/oo/classes/zcl_x/source/main',
    );
    expect(classIncludeUri('/sap/bc/adt/oo/classes/zcl_x/', 'implementations')).toBe(
      '/sap/bc/adt/oo/classes/zcl_x/includes/implementations',
    );
  });
});
