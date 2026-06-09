/**
 * ABAP debugger facade types + normalizers.
 *
 * ⚠️ EXPERIMENTAL — not validated against a live SAP yet. ABAP debugging over
 * ADT keeps server-side session state and `debuggerListen` is a long-poll that
 * blocks until a breakpoint is hit. We normalize the verbose abap-adt-api shapes
 * (UPPERCASE SAP fields) into small, LLM-friendly objects, and the client layer
 * adds a short timeout to `listen` so it never hangs an MCP turn.
 *
 * The functions here are PURE (shape mapping only) so they're unit-testable
 * without a SAP connection. The stateful calls live on CapituAdtClient.
 */

import type {
  DebugAttach,
  DebugBreakpoint,
  DebugBreakpointError,
  DebugStackInfo,
  DebugStep,
  DebugVariable,
  Debuggee,
} from 'abap-adt-api';

/** A breakpoint as the LLM sees it — id + where it sits, or an error. */
export interface NormalizedBreakpoint {
  ok: boolean;
  id?: string;
  uri?: string;
  name?: string;
  condition?: string;
  error?: string;
}

/** A program/process currently stopped (or stoppable) under debug. */
export interface NormalizedDebuggee {
  debuggeeId: string;
  program: string;
  include: string;
  line: number;
  user: string;
  description: string;
  attachImpossible: boolean;
}

export interface NormalizedStackFrame {
  position: number;
  program: string;
  include: string | number;
  line: number;
  uri: string;
  systemProgram: boolean;
}

export interface NormalizedVariable {
  id: string;
  name: string;
  type: string;
  value: string;
  kind: string;
  /** Has children (structure/table/object) worth expanding. */
  complex: boolean;
  tableLines?: number;
}

/** Outcome of a step/attach — where we are now + which breakpoints were hit. */
export interface NormalizedDebugState {
  sessionTitle: string;
  steppingPossible: boolean;
  terminationPossible: boolean;
  reachedBreakpoints: string[];
}

export function normalizeBreakpoint(
  bp: DebugBreakpoint | DebugBreakpointError,
): NormalizedBreakpoint {
  if ('errorMessage' in bp) {
    return { ok: false, error: bp.errorMessage };
  }
  return {
    ok: true,
    id: bp.id,
    uri: typeof bp.uri === 'object' ? (bp.uri as { uri?: string }).uri : undefined,
    name: bp.name,
    condition: bp.condition,
  };
}

export function normalizeDebuggee(d: Debuggee): NormalizedDebuggee {
  return {
    debuggeeId: d.DEBUGGEE_ID,
    program: d.PRG_CURR,
    include: d.INCL_CURR,
    line: d.LINE_CURR,
    user: d.DEBUGGEE_USER,
    description: d.DESCRIPTION,
    attachImpossible: d.IS_ATTACH_IMPOSSIBLE,
  };
}

export function normalizeStack(info: DebugStackInfo): NormalizedStackFrame[] {
  return info.stack.map((f) => ({
    position: f.stackPosition,
    program: f.programName,
    include: f.includeName,
    line: f.line,
    uri: typeof f.uri === 'object' ? ((f.uri as { uri?: string }).uri ?? '') : '',
    systemProgram: f.systemProgram,
  }));
}

export function normalizeVariables(vars: DebugVariable[]): NormalizedVariable[] {
  const complexTypes = new Set([
    'structure',
    'table',
    'dataref',
    'objectref',
    'class',
    'object',
    'boxref',
  ]);
  return vars.map((v) => ({
    id: v.ID,
    name: v.NAME,
    type: v.ACTUAL_TYPE_NAME || v.DECLARED_TYPE_NAME,
    value: v.VALUE,
    kind: v.KIND,
    complex: complexTypes.has(v.META_TYPE),
    tableLines: v.META_TYPE === 'table' ? v.TABLE_LINES : undefined,
  }));
}

export function normalizeDebugState(s: DebugAttach | DebugStep): NormalizedDebugState {
  return {
    sessionTitle: s.sessionTitle,
    steppingPossible: s.isSteppingPossible ?? false,
    terminationPossible: s.isTerminationPossible,
    reachedBreakpoints: (s.reachedBreakpoints ?? []).map((b) => b.id),
  };
}
