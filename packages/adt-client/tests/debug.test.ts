import { describe, expect, it, vi } from 'vitest';
import {
  normalizeBreakpoint,
  normalizeDebugState,
  normalizeDebuggee,
  normalizeStack,
  normalizeVariables,
} from '../src/debug.js';
import { CapituAdtClient } from '../src/index.js';

/**
 * Debug is EXPERIMENTAL and cannot be tested against a live SAP here. These
 * tests pin the pure normalizers (verbose SAP shapes → small LLM-friendly ones)
 * and the client's timeout behavior with a mocked inner ADTClient.
 */

describe('debug normalizers', () => {
  it('normalizeBreakpoint maps a success and an error', () => {
    expect(
      normalizeBreakpoint({
        kind: 'line',
        clientId: 'C1',
        id: 'BP1',
        nonAbapFlavour: '',
        uri: { uri: '/sap/bc/adt/oo/classes/zcl_x/source/main#start=10' } as never,
        type: '',
        name: 'ZCL_X',
        condition: 'sy-subrc = 0',
      } as never),
    ).toMatchObject({ ok: true, id: 'BP1', name: 'ZCL_X', condition: 'sy-subrc = 0' });

    expect(
      normalizeBreakpoint({
        kind: 'line',
        clientId: 'C1',
        errorMessage: 'invalid line',
        nonAbapFlavour: '',
      } as never),
    ).toEqual({ ok: false, error: 'invalid line' });
  });

  it('normalizeDebuggee picks the useful fields', () => {
    const d = normalizeDebuggee({
      DEBUGGEE_ID: 'DBG1',
      PRG_CURR: 'ZCL_X==========CP',
      INCL_CURR: 'ZCL_X==========CM001',
      LINE_CURR: 42,
      DEBUGGEE_USER: 'DEV',
      DESCRIPTION: 'class ZCL_X method M',
      IS_ATTACH_IMPOSSIBLE: false,
    } as never);
    expect(d).toEqual({
      debuggeeId: 'DBG1',
      program: 'ZCL_X==========CP',
      include: 'ZCL_X==========CM001',
      line: 42,
      user: 'DEV',
      description: 'class ZCL_X method M',
      attachImpossible: false,
    });
  });

  it('normalizeStack flattens frames', () => {
    const frames = normalizeStack({
      isRfc: false,
      isSameSystem: true,
      serverName: 'S',
      stack: [
        {
          stackPosition: 0,
          programName: 'ZCL_X',
          includeName: 'ZCL_X==CM001',
          line: 12,
          systemProgram: false,
          uri: { uri: '/sap/x' },
        } as never,
      ],
    } as never);
    expect(frames).toEqual([
      {
        position: 0,
        program: 'ZCL_X',
        include: 'ZCL_X==CM001',
        line: 12,
        uri: '/sap/x',
        systemProgram: false,
      },
    ]);
  });

  it('normalizeVariables flags complex types and table lines', () => {
    const vars = normalizeVariables([
      {
        ID: '1',
        NAME: 'LV_X',
        ACTUAL_TYPE_NAME: 'I',
        DECLARED_TYPE_NAME: 'I',
        KIND: 'local',
        VALUE: '5',
        META_TYPE: 'simple',
      } as never,
      {
        ID: '2',
        NAME: 'LT_TAB',
        ACTUAL_TYPE_NAME: 'STANDARD TABLE',
        DECLARED_TYPE_NAME: 'TY_TAB',
        KIND: 'local',
        VALUE: '',
        META_TYPE: 'table',
        TABLE_LINES: 3,
      } as never,
    ]);
    expect(vars[0]).toMatchObject({ name: 'LV_X', value: '5', complex: false });
    expect(vars[1]).toMatchObject({ name: 'LT_TAB', complex: true, tableLines: 3 });
  });

  it('normalizeDebugState extracts reached breakpoint ids', () => {
    const s = normalizeDebugState({
      sessionTitle: 'Debug ZCL_X',
      isSteppingPossible: true,
      isTerminationPossible: true,
      reachedBreakpoints: [{ id: 'BP1' }, { id: 'BP2' }],
    } as never);
    expect(s).toEqual({
      sessionTitle: 'Debug ZCL_X',
      steppingPossible: true,
      terminationPossible: true,
      reachedBreakpoints: ['BP1', 'BP2'],
    });
  });
});

describe('CapituAdtClient.debugListen timeout', () => {
  function makeClient(innerOverrides: Record<string, unknown>): CapituAdtClient {
    const c = new CapituAdtClient({ url: 'https://t.example.com', user: 'U', password: 'P' });
    const mock = {
      login: vi.fn().mockResolvedValue(undefined),
      ...innerOverrides,
    };
    (c as unknown as { inner: unknown; loggedIn: boolean }).inner = mock;
    (c as unknown as { loggedIn: boolean }).loggedIn = true;
    return c;
  }

  it('returns null when the listen long-poll exceeds the timeout', async () => {
    // inner.debuggerListen never resolves → the timeout race must win.
    const c = makeClient({ debuggerListen: vi.fn(() => new Promise(() => {})) });
    const result = await c.debugListen(1); // 1s timeout
    expect(result).toBeNull();
  });

  it('returns the normalized debuggee when a breakpoint is hit', async () => {
    const c = makeClient({
      debuggerListen: vi.fn().mockResolvedValue({
        DEBUGGEE_ID: 'DBG9',
        PRG_CURR: 'ZP',
        INCL_CURR: 'ZI',
        LINE_CURR: 7,
        DEBUGGEE_USER: 'U',
        DESCRIPTION: 'hit',
        IS_ATTACH_IMPOSSIBLE: false,
      }),
    });
    const result = await c.debugListen(5);
    expect(result).toMatchObject({ debuggeeId: 'DBG9', line: 7 });
  });
});
