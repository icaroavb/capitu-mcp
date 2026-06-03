import { z } from 'zod';
import { assertWritesEnabled } from '../context.js';
import {
  type IncludeKind,
  MethodSurgeryError,
  classIncludeUri,
  inferIncludeKind,
  spliceMethodBody,
} from '../method-surgery.js';
import type { CapituTool } from '../tool.js';

/**
 * Method-level edit for ABAP classes.
 *
 * Why it's a distinct tool (vs. capituDevWriteObject):
 *  - Saves an order of magnitude in LLM tokens. A 400-LoC class costs ~3-4k
 *    tokens to roundtrip; an edit_method call ships ~200.
 *  - Forces the caller to think "which method, which body" — that locality
 *    is itself a guardrail against accidental whole-class rewrites.
 *
 * Auto-includes detection (inspired by ARC-1 PR #261):
 *  - `lhc_*` / `lcl_*` → implementations (CCIMP)
 *  - `ltc_*`           → testclasses    (CCAU)
 *  - bare / `zif_*~m`  → main
 * Caller can pass `include` explicitly to override.
 */

const editMethodSchema = z.object({
  objectUri: z
    .string()
    .min(1)
    .describe(
      'ADT object URI of the class (NOT the source URI). Example: /sap/bc/adt/oo/classes/zcl_my_class',
    ),
  className: z
    .string()
    .min(1)
    .max(30)
    .describe(
      'Class name as in TADIR (uppercase). Used for the activate step and for safety logging.',
    ),
  methodName: z
    .string()
    .min(1)
    .describe(
      'Method to replace. Use bare name (`do_something`) if unique. Use qualified form ' +
        '`lcl_helper~do_something` when the same method name exists in multiple local classes.',
    ),
  newBody: z
    .string()
    .min(1)
    .describe(
      'New method body. Do NOT include `METHOD ... .` or `ENDMETHOD.` — only the statements ' +
        'between them. Capitu re-wraps it with the original METHOD line and matching ENDMETHOD indent.',
    ),
  include: z
    .enum(['auto', 'main', 'definitions', 'implementations', 'testclasses', 'macros'])
    .default('auto')
    .describe(
      'Which class-include the method lives in. `auto` infers from the method name prefix ' +
        '(lhc_/lcl_ → implementations, ltc_ → testclasses, else → main).',
    ),
  packageName: z
    .string()
    .min(1)
    .describe('Package of the class. Validated against CAPITU_ALLOWED_PACKAGES.'),
  transport: z.string().optional(),
  skipActivation: z.boolean().default(false),
  skipSyntaxCheck: z.boolean().default(false),
});

export interface EditMethodOutput {
  ok: boolean;
  detection: { include: IncludeKind; containingClass: string | null };
  bytesBefore: number;
  bytesAfter: number;
  tokensSavedEstimate: number;
  oldBlock: string;
  newBlock: string;
  steps: Array<{
    step: 'read' | 'splice' | 'syntax-check' | 'lock' | 'write' | 'unlock' | 'activate';
    status: 'ok' | 'skipped' | 'error';
    detail?: string;
    durationMs: number;
  }>;
  failedAt?: 'read' | 'splice' | 'syntax-check' | 'write' | 'activate';
  errorMessage?: string;
}

// Write gate shared from context.ts (assertWritesEnabled). No local copy.

export const editMethodTool: CapituTool<typeof editMethodSchema, EditMethodOutput> = {
  name: 'capituDevEditMethod',
  description:
    'Surgically edit a single method inside an ABAP class. Reads the relevant class-include ' +
    '(MAIN / CCDEF / CCIMP / CCAU), splices in the new body, writes the include back, and ' +
    'activates the class. Use this INSTEAD of capituDevWriteObject when you only need to change ' +
    'one method — typically saves 10-30x in LLM tokens vs. a full class rewrite.\n\n' +
    'The `include` parameter defaults to `auto` (inferred from method name prefix): ' +
    'lhc_/lcl_ → implementations, ltc_ → testclasses, else → main. Pass explicit value to override.',
  category: 'code-write',
  inputSchema: editMethodSchema,
  handler: async (input, ctx): Promise<EditMethodOutput> => {
    assertWritesEnabled(ctx, input.packageName);

    const includeKind: IncludeKind =
      input.include === 'auto' ? inferIncludeKind(input.methodName) : input.include;
    const sourceUri = classIncludeUri(input.objectUri, includeKind);
    const steps: EditMethodOutput['steps'] = [];

    // Step 1: read current source of the relevant include
    let currentSource: string;
    const t0 = Date.now();
    try {
      const obj = await ctx.adt.getSource(sourceUri);
      currentSource = obj.source;
      steps.push({ step: 'read', status: 'ok', durationMs: Date.now() - t0 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ step: 'read', status: 'error', detail: msg, durationMs: Date.now() - t0 });
      return errorResult(input, steps, 'read', `Failed to read include ${includeKind}: ${msg}`, '');
    }

    // Step 2: splice the new body in
    let newSource: string;
    let oldBlock: string;
    let newBlock: string;
    let containingClass: string | null = null;
    const t1 = Date.now();
    try {
      const r = spliceMethodBody(currentSource, input.methodName, input.newBody);
      newSource = r.newSource;
      oldBlock = r.oldBlock;
      newBlock = r.newBlock;
      containingClass = r.match.containingClass;
      steps.push({ step: 'splice', status: 'ok', durationMs: Date.now() - t1 });
    } catch (err) {
      const msg = err instanceof MethodSurgeryError ? `${err.code}: ${err.message}` : String(err);
      steps.push({ step: 'splice', status: 'error', detail: msg, durationMs: Date.now() - t1 });
      return errorResult(input, steps, 'splice', msg, '', {
        include: includeKind,
        containingClass: null,
      });
    }

    // Step 3: optional pre-write syntax check on the SPLICED source
    if (!input.skipSyntaxCheck) {
      const tc = Date.now();
      try {
        const findings = await ctx.adt.syntaxCheck(sourceUri, newSource);
        const errors = findings.filter((f) => f.severity === 'error');
        if (errors.length > 0) {
          const detail = errors.map((f) => `line ${f.line}: ${f.text}`).join('; ');
          steps.push({
            step: 'syntax-check',
            status: 'error',
            detail,
            durationMs: Date.now() - tc,
          });
          return errorResult(
            input,
            steps,
            'syntax-check',
            `syntax error in spliced source: ${detail}`,
            oldBlock,
            { include: includeKind, containingClass },
            newBlock,
          );
        }
        steps.push({ step: 'syntax-check', status: 'ok', durationMs: Date.now() - tc });
      } catch (err) {
        // syntax check is non-blocking — log and continue
        steps.push({
          step: 'syntax-check',
          status: 'error',
          detail: `pre-write syntax check failed to run (continuing): ${err instanceof Error ? err.message : err}`,
          durationMs: Date.now() - tc,
        });
      }
    } else {
      steps.push({ step: 'syntax-check', status: 'skipped', durationMs: 0 });
    }

    // Step 4-6: lock → write → unlock
    const tl = Date.now();
    let lockHandle: string;
    try {
      const lock = await ctx.adt.lock(input.objectUri);
      lockHandle = lock.lockHandle;
      steps.push({ step: 'lock', status: 'ok', durationMs: Date.now() - tl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ step: 'lock', status: 'error', detail: msg, durationMs: Date.now() - tl });
      return errorResult(
        input,
        steps,
        'write',
        `lock failed: ${msg}`,
        oldBlock,
        {
          include: includeKind,
          containingClass,
        },
        newBlock,
      );
    }

    const tw = Date.now();
    try {
      await ctx.adt.writeSource(sourceUri, newSource, lockHandle, input.transport);
      steps.push({ step: 'write', status: 'ok', durationMs: Date.now() - tw });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ step: 'write', status: 'error', detail: msg, durationMs: Date.now() - tw });
      // Try to unlock best-effort even on failure
      try {
        await ctx.adt.unlock(input.objectUri, lockHandle);
        steps.push({ step: 'unlock', status: 'ok', durationMs: 0 });
      } catch {
        steps.push({ step: 'unlock', status: 'error', durationMs: 0 });
      }
      return errorResult(
        input,
        steps,
        'write',
        msg,
        oldBlock,
        {
          include: includeKind,
          containingClass,
        },
        newBlock,
      );
    }

    const tu = Date.now();
    try {
      await ctx.adt.unlock(input.objectUri, lockHandle);
      steps.push({ step: 'unlock', status: 'ok', durationMs: Date.now() - tu });
    } catch {
      // unlock failures are non-fatal — log only
      steps.push({ step: 'unlock', status: 'error', durationMs: Date.now() - tu });
    }

    // Step 7: optional activate
    if (input.skipActivation) {
      steps.push({ step: 'activate', status: 'skipped', durationMs: 0 });
    } else {
      const ta = Date.now();
      try {
        const r = await ctx.adt.activate(input.className, input.objectUri);
        if (!r.success) {
          const detail = r.messages.map((m) => `${m.type}: ${m.text}`).join('; ');
          steps.push({ step: 'activate', status: 'error', detail, durationMs: Date.now() - ta });
          return errorResult(
            input,
            steps,
            'activate',
            detail || 'activation failed',
            oldBlock,
            {
              include: includeKind,
              containingClass,
            },
            newBlock,
          );
        }
        steps.push({ step: 'activate', status: 'ok', durationMs: Date.now() - ta });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({ step: 'activate', status: 'error', detail: msg, durationMs: Date.now() - ta });
        return errorResult(
          input,
          steps,
          'activate',
          msg,
          oldBlock,
          {
            include: includeKind,
            containingClass,
          },
          newBlock,
        );
      }
    }

    const bytesBefore = currentSource.length;
    const bytesAfter = newSource.length;
    // Rough token estimate: full-rewrite would have shipped the whole file;
    // edit_method ships only the body. Assume 4 bytes/token.
    const tokensSavedEstimate = Math.max(0, Math.floor((bytesBefore - input.newBody.length) / 4));

    return {
      ok: true,
      detection: { include: includeKind, containingClass },
      bytesBefore,
      bytesAfter,
      tokensSavedEstimate,
      oldBlock,
      newBlock,
      steps,
    };
  },
};

function errorResult(
  _input: { methodName: string },
  steps: EditMethodOutput['steps'],
  failedAt: NonNullable<EditMethodOutput['failedAt']>,
  errorMessage: string,
  oldBlock: string,
  detection: EditMethodOutput['detection'] = { include: 'main', containingClass: null },
  newBlock = '',
): EditMethodOutput {
  return {
    ok: false,
    detection,
    bytesBefore: 0,
    bytesAfter: 0,
    tokensSavedEstimate: 0,
    oldBlock,
    newBlock,
    steps,
    failedAt,
    errorMessage,
  };
}
