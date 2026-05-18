import { insertProposal } from '@capitu/kb';
import { z } from 'zod';
import { resolveFieldsForArtifact } from '../field-resolver.js';
import { rationaleFor, globalDesignRationale } from '../rationale.js';
import { type FieldMap, generateSkeleton } from '../skeleton-generator.js';
import { type TechnicalSpec, specToMarkdown } from '../spec-model.js';
import type { ServerContext } from '../context.js';
import type { CapituTool } from '../tool.js';

/**
 * capituSpecPropose receives a structured spec (the same shape draft accepts),
 * runs skeleton generation for each artifact that has no `source`, validates
 * cross-artifact coherence, persists the proposal in the KB with a token, and
 * returns:
 *   - the proposal token
 *   - the rendered markdown for human review
 *   - the list of artifacts in execution order (with their source)
 *
 * NOTHING is written to SAP. The user reviews and calls capituSpecApply to
 * execute or capituSpecCancel to discard.
 */

const artifactSchema = z.object({
  kind: z.enum([
    'cds-interface',
    'cds-composite',
    'cds-projection',
    'cds-extension',
    'access-control',
    'behavior-definition',
    'behavior-implementation',
    'service-definition',
    'service-binding',
    'class',
    'interface',
    'table',
    'domain',
    'data-element',
  ]),
  name: z.string().min(1).max(30),
  description: z.string().min(1).max(120),
  basedOn: z.string().optional(),
  exposes: z.array(z.string()).optional(),
  notes: z.string().optional(),
  source: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
});

const proposeSchema = z.object({
  title: z.string().min(1).max(80),
  requirement: z.string().min(1),
  approach: z.string().min(1),
  targetPackage: z.string().min(1),
  namespace: z.string().default('Z'),
  artifacts: z.array(artifactSchema).min(1),
  risks: z.array(z.string()).optional(),
});

type ProposeInput = z.output<typeof proposeSchema>;

export interface ProposedArtifact {
  kind: string;
  name: string;
  description: string;
  basedOn?: string;
  source: string;
  generator?: string;
  generationNotes: string[];
  sourceProvided: boolean;
  dependsOn: string[];
  hasPlaceholders: boolean;
  rationale: string[];
  annotationsExplained?: Record<string, string>;
  fieldResolution?: {
    baseColumns: string[];
    resolved: Array<{ alias: string; source: string | null; matchType: string }>;
  };
}

export interface ProposeOutput {
  token: string;
  status: 'pending';
  title: string;
  targetPackage: string;
  markdown: string;
  artifacts: ProposedArtifact[];
  executionOrder: string[];
  blockingErrors: string[];
  warnings: string[];
  globalRationale: string[];
  nextStep: string;
}

export const proposeTool: CapituTool<typeof proposeSchema, ProposeOutput> = {
  name: 'capituSpecPropose',
  description:
    'Build an executable spec proposal: for each artifact, either uses the provided source or generates ' +
    'a CDS/RAP skeleton based on its kind, basedOn and exposes. Cross-validates artifact coherence, ' +
    'persists the proposal in the KB with a token, and returns markdown for human review. ' +
    'NOTHING is written to SAP at this stage. Call capituSpecApply with the returned token to execute.',
  category: 'docs-read',
  inputSchema: proposeSchema,
  handler: async (input, ctx) => {
    const { artifacts, executionOrder, blockingErrors, warnings } = await buildProposedArtifacts(
      input,
      ctx,
    );

    // Global design rationale based on the mix of kinds
    const globalRationale = globalDesignRationale(
      artifacts.map((a) => ({
        kind: a.kind as Parameters<typeof globalDesignRationale>[0][number]['kind'],
        name: a.name,
        description: a.description,
        basedOn: a.basedOn,
      })),
    );

    // Build spec for markdown rendering
    const spec: TechnicalSpec = {
      title: input.title,
      requirement: input.requirement,
      approach: input.approach,
      targetPackage: input.targetPackage,
      namespace: input.namespace,
      artifacts: artifacts.map((a) => ({
        kind: a.kind as TechnicalSpec['artifacts'][number]['kind'],
        name: a.name,
        description: a.description,
        basedOn: a.basedOn,
        notes: a.generationNotes.join(' / ') || undefined,
      })),
      risks: input.risks,
    };

    const markdown = composeProposalMarkdown(
      spec,
      artifacts,
      executionOrder,
      blockingErrors,
      warnings,
      globalRationale,
    );

    // Persist proposal
    const token = insertProposal(ctx.kb, {
      title: input.title,
      targetPackage: input.targetPackage,
      payload: {
        title: input.title,
        targetPackage: input.targetPackage,
        artifacts,
        executionOrder,
        sourceAgent: ctx.agent,
      },
    });

    return {
      token,
      status: 'pending',
      title: input.title,
      targetPackage: input.targetPackage,
      markdown,
      artifacts,
      executionOrder,
      blockingErrors,
      warnings,
      globalRationale,
      nextStep:
        blockingErrors.length > 0
          ? 'Fix the blocking errors and call capituSpecPropose again with adjusted artifacts.'
          : `Review the markdown. To execute, call capituSpecApply with token="${token}" and confirmed=true. To discard, call with confirmed=false.`,
    };
  },
};

async function buildProposedArtifacts(
  input: ProposeInput,
  ctx: ServerContext,
): Promise<{
  artifacts: ProposedArtifact[];
  executionOrder: string[];
  blockingErrors: string[];
  warnings: string[];
}> {
  const blockingErrors: string[] = [];
  const warnings: string[] = [];

  // Pass 1: detect duplicate (kind+name) and same-name conflicts
  const nameMap = new Map<string, string[]>();
  for (const a of input.artifacts) {
    const key = a.name.toUpperCase();
    const list = nameMap.get(key) ?? [];
    list.push(a.kind);
    nameMap.set(key, list);
  }
  for (const [name, kinds] of nameMap) {
    if (kinds.length > 1) {
      // Allow BDEF + CDS root with same name (RAP convention)
      const set = new Set(kinds);
      const isRapPair =
        set.has('behavior-definition') &&
        (set.has('cds-interface') || set.has('cds-composite') || set.has('cds-projection'));
      if (!isRapPair) {
        blockingErrors.push(
          `Name collision: "${name}" used for kinds [${kinds.join(', ')}]. Pick distinct names per artifact (RAP allows BDEF + root view to share name).`,
        );
      }
    }
  }

  // Pass 2: normalize names, resolve fields via ADT (best-effort), generate source
  const artifacts: ProposedArtifact[] = [];
  for (const a of input.artifacts) {
    const upper = a.name.toUpperCase();
    const dependsOn = a.dependsOn ?? inferDeps(a, input.artifacts);

    // Try field resolution against tenant when applicable. We only do this for
    // CDS interface/composite/extension that have basedOn + exposes.
    let fieldMap: FieldMap | undefined;
    let fieldResolution: ProposedArtifact['fieldResolution'];
    const eligibleForResolve =
      (a.kind === 'cds-interface' || a.kind === 'cds-composite' || a.kind === 'cds-extension') &&
      !!a.basedOn &&
      Array.isArray(a.exposes) &&
      a.exposes.length > 0 &&
      !a.source; // skip resolve if caller already provided source

    if (eligibleForResolve && a.basedOn && a.exposes) {
      try {
        const resolved = await resolveFieldsForArtifact(ctx.adt, a.basedOn, a.exposes);
        if (resolved) {
          fieldMap = {};
          for (const m of resolved.matches) {
            fieldMap[m.alias] = m.source;
          }
          fieldResolution = {
            baseColumns: resolved.baseColumns.slice(0, 50), // cap to avoid bloating output
            resolved: resolved.matches.map((m) => ({
              alias: m.alias,
              source: m.source,
              matchType: m.matchType,
            })),
          };
          for (const w of resolved.warnings) warnings.push(w);
        }
      } catch (err) {
        warnings.push(
          `Field resolver failed for ${a.basedOn}: ${err instanceof Error ? err.message : err}. Falling back to <SOURCE_FIELD> placeholders.`,
        );
      }
    }

    let source = a.source;
    let generator: string | undefined;
    const generationNotes: string[] = [];
    let hasPlaceholders = false;
    let sourceProvided = false;
    if (source) {
      sourceProvided = true;
    } else {
      const sk = generateSkeleton({ ...a, name: upper }, fieldMap);
      if (sk) {
        source = sk.source;
        generator = sk.generator;
        generationNotes.push(...sk.notes);
        hasPlaceholders = sk.hasPlaceholders;
      } else {
        source = '';
        warnings.push(
          `No skeleton generator for kind="${a.kind}" on "${upper}". Provide explicit source in the artifact or skip via skipKinds in capituSpecApply.`,
        );
      }
    }

    const r = rationaleFor({
      kind: a.kind as Parameters<typeof rationaleFor>[0]['kind'],
      name: upper,
      description: a.description,
      basedOn: a.basedOn,
    });

    artifacts.push({
      kind: a.kind,
      name: upper,
      description: a.description,
      basedOn: a.basedOn,
      source: source ?? '',
      generator,
      generationNotes,
      sourceProvided,
      dependsOn,
      hasPlaceholders,
      rationale: r.bullets,
      annotationsExplained: r.annotationsExplained,
      fieldResolution,
    });
  }

  // Pass 3: topological order based on dependsOn
  const executionOrder = topoSort(artifacts, blockingErrors);

  // Pass 4: extra coherence checks
  const hasBdef = artifacts.some((a) => a.kind === 'behavior-definition');
  const hasBimpl = artifacts.some((a) => a.kind === 'behavior-implementation');
  if (hasBdef && !hasBimpl) {
    warnings.push(
      'Behavior definition present without implementation class — capitu cannot generate the class skeleton automatically. Add a "behavior-implementation" artifact with explicit source, or accept that BDEF will fail to activate.',
    );
  }
  const hasSrvb = artifacts.some((a) => a.kind === 'service-binding');
  if (hasSrvb) {
    warnings.push(
      'Service bindings are NOT auto-generated (they are XML-ish and require ADT wizard). The apply step will skip the binding artifact — create it manually in Eclipse after the other objects activate.',
    );
  }

  return { artifacts, executionOrder, blockingErrors, warnings };
}

const KIND_ORDER: Record<string, number> = {
  domain: 1,
  'data-element': 2,
  table: 3,
  'cds-interface': 4,
  'cds-extension': 5,
  'cds-composite': 6,
  'cds-projection': 7,
  'access-control': 8,
  'behavior-definition': 9,
  'behavior-implementation': 10,
  'service-definition': 11,
  'service-binding': 12,
  class: 13,
  interface: 14,
};

function inferDeps(
  a: { kind: string; name: string; basedOn?: string },
  all: Array<{ kind: string; name: string }>,
): string[] {
  if (!a.basedOn) return [];
  const upper = a.basedOn.toUpperCase();
  const found = all.find((other) => other.name.toUpperCase() === upper);
  return found ? [found.name.toUpperCase()] : [];
}

function topoSort(arts: ProposedArtifact[], blocking: string[]): string[] {
  // Stable sort by KIND_ORDER first, then verify declared dependsOn don't violate.
  const byOrder = [...arts].sort((a, b) => {
    const ka = KIND_ORDER[a.kind] ?? 999;
    const kb = KIND_ORDER[b.kind] ?? 999;
    return ka - kb;
  });
  const positions = new Map(byOrder.map((a, i) => [a.name, i]));
  for (const a of arts) {
    for (const dep of a.dependsOn) {
      const depUpper = dep.toUpperCase();
      const ownPos = positions.get(a.name) ?? -1;
      const depPos = positions.get(depUpper) ?? -1;
      if (depPos < 0) {
        blocking.push(
          `Artifact "${a.name}" declares dependency on "${depUpper}" which is not in the proposal.`,
        );
        continue;
      }
      if (depPos >= ownPos) {
        blocking.push(
          `Dependency cycle or wrong order: "${a.name}" depends on "${depUpper}" but that artifact comes later in the inferred order. Review kinds.`,
        );
      }
    }
  }
  return byOrder.map((a) => a.name);
}

function composeProposalMarkdown(
  spec: TechnicalSpec,
  artifacts: ProposedArtifact[],
  executionOrder: string[],
  blockingErrors: string[],
  warnings: string[],
  globalRationale: string[],
): string {
  const head = specToMarkdown(spec);
  const lines: string[] = ['', '## Proposal'];

  if (globalRationale.length) {
    lines.push('', '### Design rationale');
    for (const r of globalRationale) lines.push(`- ${r}`);
  }

  if (blockingErrors.length) {
    lines.push('', '### 🛑 Blocking errors');
    for (const e of blockingErrors) lines.push(`- ${e}`);
  }
  if (warnings.length) {
    lines.push('', '### ⚠️ Warnings');
    for (const w of warnings) lines.push(`- ${w}`);
  }

  lines.push('', '### Execution order');
  executionOrder.forEach((name, i) => lines.push(`${i + 1}. \`${name}\``));

  lines.push('', '### Artifacts');
  for (const a of artifacts) {
    lines.push('', `#### \`${a.name}\` — ${a.kind}`);

    // Rationale first — it's the "why"
    if (a.rationale.length) {
      lines.push('');
      lines.push('**Por que este artefato:**');
      for (const r of a.rationale) lines.push(`- ${r}`);
    }

    // Source preview
    if (a.sourceProvided) {
      lines.push('', '_Source provided by caller._');
    } else if (a.generator) {
      lines.push('', `_Source generated by \`${a.generator}\`${a.hasPlaceholders ? ' — contains <PLACEHOLDERS> that must be reviewed before apply' : ''}._`);
    } else {
      lines.push('', '_No source available — this artifact will be skipped on apply._');
    }

    // Field resolution detail (if any)
    if (a.fieldResolution && a.fieldResolution.resolved.length > 0) {
      lines.push('', '**Field resolution (read from tenant):**');
      lines.push('');
      lines.push('| Alias | Source column | Match |');
      lines.push('|-------|---------------|-------|');
      for (const r of a.fieldResolution.resolved) {
        const src = r.source ?? '`<SOURCE_FIELD>` (not matched)';
        lines.push(`| \`${r.alias}\` | ${src} | ${r.matchType} |`);
      }
      if (a.fieldResolution.baseColumns.length > 0) {
        lines.push('');
        lines.push(
          `_Available columns in \`${a.basedOn}\`:_ ${a.fieldResolution.baseColumns
            .map((c) => `\`${c}\``)
            .join(', ')}`,
        );
      }
    }

    if (a.generationNotes.length) {
      lines.push('');
      for (const n of a.generationNotes) lines.push(`> ${n}`);
    }

    if (a.source) {
      lines.push('', '```abap');
      lines.push(a.source.trimEnd());
      lines.push('```');
    }

    // Annotation explanations
    if (a.annotationsExplained && Object.keys(a.annotationsExplained).length > 0) {
      lines.push('', '<details><summary>Annotations explicadas</summary>', '');
      for (const [ann, expl] of Object.entries(a.annotationsExplained)) {
        lines.push(`- \`${ann}\` — ${expl}`);
      }
      lines.push('', '</details>');
    }
  }
  return head + '\n' + lines.join('\n');
}
