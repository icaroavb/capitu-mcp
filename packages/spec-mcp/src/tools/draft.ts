import { z } from 'zod';
import {
  type Artifact,
  type ArtifactKind,
  type ImplementationStep,
  type SpecConsideration,
  type TechnicalSpec,
  specToMarkdown,
} from '../spec-model.js';
import type { CapituTool } from '../tool.js';

/**
 * capituSpecDraft is intentionally NOT an LLM call. It is a structured
 * builder: the LLM client (Claude) decides the artifacts list by analyzing
 * the requirement, then passes the structured input here. The tool's job is
 * to (1) normalize/validate the input, (2) infer missing metadata where it
 * can (defaults, naming hints, step order), (3) serialize to markdown.
 *
 * This split keeps the agent server stateless and deterministic. The LLM
 * brings the creativity; capitu enforces structure and tenant fit.
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
});

const considerationSchema = z.object({
  area: z.enum(['authorization', 'performance', 'transport', 'extensibility', 'data-quality']),
  text: z.string().min(1),
});

const draftSchema = z.object({
  title: z.string().min(1).max(80).describe('Short title that summarizes the requirement'),
  requirement: z
    .string()
    .min(1)
    .describe('Original requirement in natural language (verbatim, for traceability)'),
  approach: z
    .string()
    .min(1)
    .describe('2-4 sentence summary of the technical approach'),
  targetPackage: z
    .string()
    .min(1)
    .describe('Target ABAP package, e.g. ZMY_PROJECT, $TMP'),
  namespace: z.string().default('Z').describe('Object name prefix the team uses'),
  artifacts: z
    .array(artifactSchema)
    .min(1)
    .describe(
      'List of concrete ABAP objects to create. Kinds: cds-interface (ZI_*), cds-composite (ZC_*), cds-projection (ZP_*), behavior-definition, service-binding etc.',
    ),
  considerations: z.array(considerationSchema).optional(),
  risks: z.array(z.string()).optional(),
});

export interface DraftOutput {
  markdown: string;
  artifactCount: number;
  warnings: string[];
}

export const draftTool: CapituTool<typeof draftSchema, DraftOutput> = {
  name: 'capituSpecDraft',
  description:
    'Compose a structured SAP technical specification (CDS/RAP/services) from a requirement and an artifact list. ' +
    'You (the LLM) analyze the requirement and propose artifacts; this tool normalizes, applies naming/order heuristics ' +
    'and emits a markdown spec ready for review. For best results: name CDS views with ZI_/ZC_/ZP_ prefixes, set basedOn ' +
    'to the underlying released entity (or /dmo/* for demo), and let the tool infer implementation steps.',
  category: 'docs-read',
  inputSchema: draftSchema,
  handler: async (input, _ctx) => {
    const warnings: string[] = [];
    const artifacts = input.artifacts.map((a) => normalizeArtifact(a, input.namespace, warnings));

    // Cross-checks
    crossCheckArtifacts(artifacts, warnings);

    const steps = inferImplementationSteps(artifacts);
    const considerations = withDefaultConsiderations(input.considerations ?? [], artifacts);

    const spec: TechnicalSpec = {
      title: input.title,
      requirement: input.requirement,
      approach: input.approach,
      targetPackage: input.targetPackage,
      namespace: input.namespace,
      artifacts,
      considerations,
      risks: input.risks,
      steps,
    };

    return {
      markdown: specToMarkdown(spec),
      artifactCount: artifacts.length,
      warnings,
    };
  },
};

// ---- Normalization & heuristics --------------------------------------------

function normalizeArtifact(a: Artifact, namespace: string, warnings: string[]): Artifact {
  const upper = a.name.toUpperCase();
  if (!upper.startsWith(namespace) && !upper.startsWith('/')) {
    warnings.push(
      `Artifact "${a.name}" does not start with namespace prefix "${namespace}". Renaming to "${namespace}_${upper}".`,
    );
    return { ...a, name: `${namespace}_${upper}` };
  }
  // Suggest more specific CDS prefixes
  if (a.kind === 'cds-interface' && !upper.startsWith(`${namespace}I_`)) {
    warnings.push(
      `Interface CDS "${a.name}" conventionally uses "${namespace}I_" prefix (e.g. ${namespace}I_${upper.replace(`${namespace}_`, '')}).`,
    );
  }
  if (a.kind === 'cds-composite' && !upper.startsWith(`${namespace}C_`)) {
    warnings.push(
      `Composite CDS "${a.name}" conventionally uses "${namespace}C_" prefix.`,
    );
  }
  if (a.kind === 'cds-projection' && !upper.startsWith(`${namespace}P_`)) {
    warnings.push(
      `Projection CDS "${a.name}" conventionally uses "${namespace}P_" prefix.`,
    );
  }
  return { ...a, name: upper };
}

function crossCheckArtifacts(arts: Artifact[], warnings: string[]): void {
  const hasBdef = arts.some((a) => a.kind === 'behavior-definition');
  const hasBimpl = arts.some((a) => a.kind === 'behavior-implementation');
  if (hasBdef && !hasBimpl) {
    warnings.push(
      'Behavior definition present but no behavior implementation class declared. RAP needs both.',
    );
  }
  const hasSrvd = arts.some((a) => a.kind === 'service-definition');
  const hasSrvb = arts.some((a) => a.kind === 'service-binding');
  if (hasSrvb && !hasSrvd) {
    warnings.push('Service binding requires a service definition. Add a "service-definition" artifact.');
  }
  const hasProjection = arts.some((a) => a.kind === 'cds-projection');
  if (hasSrvd && !hasProjection) {
    warnings.push('Service definition typically exposes one or more projection views (ZP_*).');
  }
}

function inferImplementationSteps(arts: Artifact[]): ImplementationStep[] {
  // Order respecting RAP dependency: tables/elements -> interface CDS -> composite -> projection -> DCL -> BDEF -> BIMPL -> SRVD -> SRVB
  const ORDER: ArtifactKind[] = [
    'domain',
    'data-element',
    'table',
    'cds-interface',
    'cds-extension',
    'cds-composite',
    'cds-projection',
    'access-control',
    'behavior-definition',
    'behavior-implementation',
    'service-definition',
    'service-binding',
    'class',
    'interface',
  ];

  const groups: Record<string, Artifact[]> = {};
  for (const a of arts) {
    const key = a.kind;
    (groups[key] ??= []).push(a);
  }

  const steps: ImplementationStep[] = [];
  let order = 1;
  for (const kind of ORDER) {
    const list = groups[kind];
    if (!list || list.length === 0) continue;
    steps.push({
      order: order++,
      title: stepTitleFor(kind),
      artifacts: list.map((a) => a.name),
      capituDevCall: hintCapituDevFor(kind),
    });
  }
  return steps;
}

function stepTitleFor(kind: ArtifactKind): string {
  switch (kind) {
    case 'cds-interface':
      return 'Create interface CDS views (data layer)';
    case 'cds-composite':
      return 'Create composite views (aggregation layer)';
    case 'cds-projection':
      return 'Create projection views (consumption layer)';
    case 'cds-extension':
      return 'Extend existing released CDS';
    case 'access-control':
      return 'Create DCL access control';
    case 'behavior-definition':
      return 'Define behavior (RAP BDEF)';
    case 'behavior-implementation':
      return 'Implement behavior class';
    case 'service-definition':
      return 'Create service definition';
    case 'service-binding':
      return 'Create OData V4 service binding';
    case 'class':
      return 'Create utility classes';
    case 'interface':
      return 'Create ABAP interfaces';
    case 'table':
      return 'Create database tables';
    case 'domain':
      return 'Create DDIC domains';
    case 'data-element':
      return 'Create DDIC data elements';
  }
}

function hintCapituDevFor(kind: ArtifactKind): string | undefined {
  switch (kind) {
    case 'cds-interface':
    case 'cds-composite':
    case 'cds-projection':
      return 'capituDevCreateObject(objectType="DDLS/DF", ...)';
    case 'access-control':
      return 'capituDevCreateObject(objectType="DCLS/DL", ...)';
    case 'class':
    case 'behavior-implementation':
      return 'capituDevCreateObject(objectType="CLAS/OC", ...)';
    case 'interface':
      return 'capituDevCreateObject(objectType="INTF/OI", ...)';
    case 'table':
      return 'capituDevCreateObject(objectType="TABL/DT", ...)';
    case 'domain':
      return 'capituDevCreateObject(objectType="DOMA/DD", ...)';
    case 'data-element':
      return 'capituDevCreateObject(objectType="DTEL/DE", ...)';
    default:
      return undefined;
  }
}

function withDefaultConsiderations(
  existing: SpecConsideration[],
  arts: Artifact[],
): SpecConsideration[] {
  const out = [...existing];
  const seen = new Set(existing.map((c) => c.area));

  if (arts.some((a) => a.kind === 'service-binding') && !seen.has('authorization')) {
    out.push({
      area: 'authorization',
      text:
        'OData service exposed to end users — DCL access control is mandatory before going live. Confirm authorization object reuse vs custom.',
    });
  }
  if (arts.some((a) => a.basedOn?.startsWith('/dmo/')) && !seen.has('data-quality')) {
    out.push({
      area: 'data-quality',
      text:
        'Spec references /dmo/* demo entities. These are SAP-provided sandbox tables, not production-ready. Replace with released APIs (C1/C2) before promoting beyond $TMP.',
    });
  }
  if (!seen.has('transport')) {
    out.push({
      area: 'transport',
      text:
        'For target packages other than $TMP, attach all created objects to the same transport request. Use capituDevListTransports to pick one.',
    });
  }
  return out;
}
