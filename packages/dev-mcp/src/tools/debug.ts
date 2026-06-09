import { z } from 'zod';
import type { CapituTool } from '../tool.js';

/**
 * ABAP debugger — multi-action tool. ⚠️ EXPERIMENTAL: implemented against the
 * abap-adt-api debugger API but NOT yet validated against a live SAP. Debugging
 * over ADT keeps server-side session state and `listen` is a long-poll; the
 * client caps it with a timeout so it never hangs a turn.
 *
 * Category 'debug' — Q33-endorsed (debugging your own code). Read/observe +
 * flow-control only; it does not write objects, so it bypasses the write gate.
 *
 * Typical flow:
 *   1. set_breakpoints on your code
 *   2. trigger the code in SAP GUI / Fiori / a job
 *   3. listen  → returns the stopped program (or null on timeout — retry)
 *   4. attach  → read session state
 *   5. stack / variables → inspect
 *   6. step (stepInto/Over/Return/Continue) → advance
 *   7. stop → release the listener
 */

const debugSchema = z.object({
  action: z
    .enum(['set_breakpoints', 'listen', 'attach', 'stack', 'variables', 'step', 'stop'])
    .describe('Which debug operation to run.'),
  // set_breakpoints
  sourceUri: z
    .string()
    .optional()
    .describe('set_breakpoints: ADT source URI (e.g. /sap/bc/adt/oo/classes/zcl_x/source/main).'),
  lines: z
    .array(z.number().int().min(1))
    .optional()
    .describe('set_breakpoints: 1-based line numbers to break on.'),
  // listen
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(55)
    .optional()
    .describe('listen: how long to wait for a breakpoint hit (default 20, max 55).'),
  // attach
  debuggeeId: z.string().optional().describe('attach: the debuggee id returned by listen.'),
  // variables
  variables: z
    .array(z.string())
    .optional()
    .describe('variables: variable names (top-level) or child ids to expand.'),
  // step
  stepType: z
    .enum([
      'stepInto',
      'stepOver',
      'stepReturn',
      'stepContinue',
      'stepRunToLine',
      'stepJumpToLine',
      'terminateDebuggee',
    ])
    .optional()
    .describe('step: the step kind.'),
  stepUri: z.string().optional().describe('step: target uri for stepRunToLine / stepJumpToLine.'),
});

export interface DebugOutput {
  action: string;
  note?: string;
  result: unknown;
}

const EXPERIMENTAL_NOTE =
  'EXPERIMENTAL: debug over ADT is not yet validated against a live SAP; behavior may vary by release.';

export const debugTool: CapituTool<typeof debugSchema, DebugOutput> = {
  name: 'capituDevDebug',
  description:
    'ABAP debugger (EXPERIMENTAL). Set breakpoints, listen for a hit, attach, inspect the ' +
    'call stack and variables, and step through your own code. Flow: set_breakpoints → ' +
    '(trigger code in SAP) → listen → attach → stack/variables → step → stop. The "listen" ' +
    'action waits up to timeoutSeconds and returns null if nothing hit yet (just retry).',
  category: 'debug',
  inputSchema: debugSchema,
  handler: async (input, ctx): Promise<DebugOutput> => {
    const adt = ctx.adt;
    switch (input.action) {
      case 'set_breakpoints': {
        if (!input.sourceUri || !input.lines || input.lines.length === 0) {
          throw new Error('set_breakpoints requires sourceUri and a non-empty lines array.');
        }
        const result = await adt.debugSetBreakpoints(input.sourceUri, input.lines);
        return { action: input.action, note: EXPERIMENTAL_NOTE, result };
      }
      case 'listen': {
        const debuggee = await adt.debugListen(input.timeoutSeconds ?? 20);
        return {
          action: input.action,
          note: debuggee
            ? EXPERIMENTAL_NOTE
            : `No breakpoint hit within the timeout. Trigger the code in SAP and call listen again. ${EXPERIMENTAL_NOTE}`,
          result: debuggee,
        };
      }
      case 'attach': {
        if (!input.debuggeeId) throw new Error('attach requires debuggeeId (from listen).');
        const result = await adt.debugAttach(input.debuggeeId);
        return { action: input.action, note: EXPERIMENTAL_NOTE, result };
      }
      case 'stack': {
        const result = await adt.debugStackTrace();
        return { action: input.action, note: EXPERIMENTAL_NOTE, result };
      }
      case 'variables': {
        if (!input.variables || input.variables.length === 0) {
          throw new Error('variables requires a non-empty variables array (names or child ids).');
        }
        const result = await adt.debugVariables(input.variables);
        return { action: input.action, note: EXPERIMENTAL_NOTE, result };
      }
      case 'step': {
        if (!input.stepType) throw new Error('step requires stepType.');
        const result = await adt.debugStep(input.stepType, input.stepUri);
        return { action: input.action, note: EXPERIMENTAL_NOTE, result };
      }
      case 'stop': {
        await adt.debugDeleteListener();
        return { action: input.action, note: EXPERIMENTAL_NOTE, result: { stopped: true } };
      }
    }
  },
};
