import { getProposal, updateProposalStatus } from '@capitu/kb';
import { z } from 'zod';
import type { CapituTool } from '../tool.js';
import type { ProposedArtifact } from './propose.js';

/**
 * capituSpecApply executes a previously-proposed plan.
 *
 * Required step: the user must explicitly confirm with confirmed=true. This
 * is a deliberate friction point — proposals never auto-execute.
 *
 * Execution model: iterates artifacts in the proposal's executionOrder. For
 * each, calls the ADT client to create+write+activate (mirroring what
 * capituDevApplyArtifact does inside dev-mcp). If a step fails, the loop
 * stops, the proposal is marked 'partial', and the partial log is returned.
 *
 * Why duplicate the apply logic instead of calling capituDevApplyArtifact:
 * MCP tools cannot directly call other MCP servers from inside their handler.
 * The cleanest way is to use the shared @capitu/adt-client which both servers
 * already depend on.
 */

interface ProposalPayload {
  title: string;
  targetPackage: string;
  artifacts: ProposedArtifact[];
  executionOrder: string[];
  sourceAgent: string;
}

const applySchema = z.object({
  token: z.string().uuid().describe('Proposal token returned by capituSpecPropose'),
  confirmed: z
    .boolean()
    .describe(
      'Required explicit confirmation. true → execute. false → cancel and mark proposal as cancelled.',
    ),
  transport: z
    .string()
    .optional()
    .describe('Optional transport request to attach all artifacts to. Omit for $TMP.'),
  skipKinds: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of artifact kinds to skip (e.g. ["service-binding","behavior-implementation"]) when their source is empty.',
    ),
  stopOnError: z
    .boolean()
    .default(true)
    .describe('If true (default), stops at the first failed artifact. If false, tries to apply each independently.'),
});

export interface ApplyStepLog {
  artifact: string;
  kind: string;
  status: 'ok' | 'error' | 'skipped';
  reason?: string;
  durationMs: number;
  steps?: Array<{ step: string; status: string; detail?: string }>;
}

export interface ApplyOutput {
  ok: boolean;
  status: 'applied' | 'partial' | 'cancelled' | 'rejected';
  token: string;
  applied: number;
  failed: number;
  skipped: number;
  log: ApplyStepLog[];
  summary: string;
}

const TYPE_MAP: Record<string, string> = {
  'cds-interface': 'DDLS/DF',
  'cds-composite': 'DDLS/DF',
  'cds-projection': 'DDLS/DF',
  'cds-extension': 'DDLS/DF',
  'access-control': 'DCLS/DL',
  'behavior-definition': 'BDEF/BDO', // not in CreatableTypeIds — will likely fail; we surface as error
  'behavior-implementation': 'CLAS/OC',
  'service-definition': 'SRVD/SRV',
  'service-binding': 'SRVB/SVB',
  class: 'CLAS/OC',
  interface: 'INTF/OI',
  table: 'TABL/DT',
  domain: 'DOMA/DD',
  'data-element': 'DTEL/DE',
};

export const applyTool: CapituTool<typeof applySchema, ApplyOutput> = {
  name: 'capituSpecApply',
  description:
    'Execute a previously proposed spec. Requires explicit confirmed=true. ' +
    'Iterates the proposal artifacts in executionOrder and for each one performs create + write + ' +
    'activate via the shared ADT client. Marks the proposal as applied/partial/cancelled in the KB. ' +
    'IMPORTANT: this DOES write to SAP — only call after the user has reviewed the proposal markdown.',
  category: 'code-write',
  inputSchema: applySchema,
  handler: async (input, ctx): Promise<ApplyOutput> => {
    const proposal = getProposal<ProposalPayload>(ctx.kb, input.token);
    if (!proposal) {
      return rejected(input.token, 'Proposal not found. Did you save the token from capituSpecPropose?');
    }
    if (proposal.status !== 'pending') {
      return rejected(
        input.token,
        `Proposal status is "${proposal.status}". Only pending proposals can be applied. Run capituSpecPropose again to create a fresh one.`,
      );
    }
    if (!input.confirmed) {
      updateProposalStatus(ctx.kb, input.token, 'cancelled', { reason: 'user declined' });
      return {
        ok: true,
        status: 'cancelled',
        token: input.token,
        applied: 0,
        failed: 0,
        skipped: 0,
        log: [],
        summary: 'Proposal cancelled — no changes made.',
      };
    }

    const skipSet = new Set(input.skipKinds ?? []);
    const log: ApplyStepLog[] = [];
    let applied = 0;
    let failed = 0;
    let skipped = 0;

    const byName = new Map(proposal.payload.artifacts.map((a) => [a.name, a]));
    for (const name of proposal.payload.executionOrder) {
      const art = byName.get(name);
      if (!art) continue;
      const adtType = TYPE_MAP[art.kind];
      if (!adtType || !art.source) {
        skipped++;
        log.push({
          artifact: art.name,
          kind: art.kind,
          status: 'skipped',
          reason: !art.source
            ? 'no source available (skeleton generator returned null and no source was provided)'
            : `kind "${art.kind}" not supported by capitu apply`,
          durationMs: 0,
        });
        continue;
      }
      if (skipSet.has(art.kind)) {
        skipped++;
        log.push({
          artifact: art.name,
          kind: art.kind,
          status: 'skipped',
          reason: `kind "${art.kind}" listed in skipKinds`,
          durationMs: 0,
        });
        continue;
      }
      const result = await applyOne(art, adtType, proposal.payload.targetPackage, input.transport, ctx);
      log.push(result);
      if (result.status === 'ok') {
        applied++;
      } else {
        failed++;
        if (input.stopOnError) break;
      }
    }

    const finalStatus =
      failed === 0 && applied > 0 ? 'applied' : applied > 0 ? 'partial' : 'partial';
    updateProposalStatus(ctx.kb, input.token, finalStatus, { applied, failed, skipped, log });

    return {
      ok: failed === 0,
      status: finalStatus,
      token: input.token,
      applied,
      failed,
      skipped,
      log,
      summary: composeSummary(applied, failed, skipped, log),
    };
  },
};

async function applyOne(
  art: ProposedArtifact,
  adtType: string,
  targetPackage: string,
  transport: string | undefined,
  ctx: Parameters<typeof applyTool.handler>[1],
): Promise<ApplyStepLog> {
  const start = Date.now();
  const steps: ApplyStepLog['steps'] = [];

  try {
    await ctx.adt.createObject({
      objectType: adtType,
      name: art.name,
      description: art.description,
      packageName: targetPackage,
      transport,
    });
    steps.push({ step: 'create', status: 'ok' });
  } catch (err) {
    steps.push({
      step: 'create',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      artifact: art.name,
      kind: art.kind,
      status: 'error',
      reason: `create failed: ${err instanceof Error ? err.message : err}`,
      durationMs: Date.now() - start,
      steps,
    };
  }

  const sourceUri = buildSourceUri(adtType, art.name);
  const objectUri = buildObjectUri(adtType, art.name);
  try {
    const lock = await ctx.adt.lock(objectUri);
    try {
      await ctx.adt.writeSource(sourceUri, art.source, lock.lockHandle, transport);
    } finally {
      try {
        await ctx.adt.unlock(objectUri, lock.lockHandle);
      } catch {
        // best-effort
      }
    }
    steps.push({ step: 'write', status: 'ok' });
  } catch (err) {
    steps.push({
      step: 'write',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      artifact: art.name,
      kind: art.kind,
      status: 'error',
      reason: `write failed: ${err instanceof Error ? err.message : err}`,
      durationMs: Date.now() - start,
      steps,
    };
  }

  try {
    const r = await ctx.adt.activate(art.name, objectUri);
    if (!r.success) {
      const msg = r.messages.map((m) => `${m.type}: ${m.text}`).join('; ');
      steps.push({ step: 'activate', status: 'error', detail: msg });
      return {
        artifact: art.name,
        kind: art.kind,
        status: 'error',
        reason: `activation failed: ${msg || 'unknown'}`,
        durationMs: Date.now() - start,
        steps,
      };
    }
    steps.push({ step: 'activate', status: 'ok' });
  } catch (err) {
    steps.push({
      step: 'activate',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      artifact: art.name,
      kind: art.kind,
      status: 'error',
      reason: `activate threw: ${err instanceof Error ? err.message : err}`,
      durationMs: Date.now() - start,
      steps,
    };
  }

  return {
    artifact: art.name,
    kind: art.kind,
    status: 'ok',
    durationMs: Date.now() - start,
    steps,
  };
}

function buildObjectUri(adtType: string, name: string): string {
  const ln = name.toLowerCase();
  switch (adtType) {
    case 'DDLS/DF':
      return `/sap/bc/adt/ddic/ddl/sources/${ln}`;
    case 'CLAS/OC':
      return `/sap/bc/adt/oo/classes/${ln}`;
    case 'INTF/OI':
      return `/sap/bc/adt/oo/interfaces/${ln}`;
    case 'DCLS/DL':
      return `/sap/bc/adt/acm/dcl/sources/${ln}`;
    case 'SRVD/SRV':
      return `/sap/bc/adt/ddic/srvd/sources/${ln}`;
    case 'TABL/DT':
      return `/sap/bc/adt/ddic/tables/${ln}`;
    case 'DOMA/DD':
      return `/sap/bc/adt/ddic/domains/${ln}`;
    case 'DTEL/DE':
      return `/sap/bc/adt/ddic/dataelements/${ln}`;
    default:
      return `/sap/bc/adt/${ln}`;
  }
}

function buildSourceUri(adtType: string, name: string): string {
  return `${buildObjectUri(adtType, name)}/source/main`;
}

function rejected(token: string, summary: string): ApplyOutput {
  return {
    ok: false,
    status: 'rejected',
    token,
    applied: 0,
    failed: 0,
    skipped: 0,
    log: [],
    summary,
  };
}

function composeSummary(
  applied: number,
  failed: number,
  skipped: number,
  log: ApplyStepLog[],
): string {
  const head = `Applied ${applied} / Failed ${failed} / Skipped ${skipped}.`;
  if (failed === 0 && applied > 0) {
    return `${head} All artifacts activated successfully.`;
  }
  const errors = log
    .filter((l) => l.status === 'error')
    .map((l) => `- ${l.artifact}: ${l.reason}`)
    .join('\n');
  return `${head}\nFirst failure stopped execution (or partial run). Errors:\n${errors}`;
}
