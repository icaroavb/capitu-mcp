/**
 * Canonical model of a capitu-spec output.
 *
 * The agent builds a TechnicalSpec structure from a requirement and serializes
 * it to markdown. The structure is opinionated towards modern ABAP / RAP / CDS
 * patterns — the kind of artifacts you'd actually create in S/4HANA today.
 *
 * Why structured first, markdown second:
 *   - We can validate completeness programmatically (missing service binding?)
 *   - We can re-serialize the same spec in different formats later (JSON, YAML)
 *   - The capitu-dev agent could in the future consume the JSON directly
 *
 * For now the public API returns markdown to the LLM client.
 */

export type AbapNamespace = 'Z' | 'Y' | string; // any starting prefix

export interface TechnicalSpec {
  /** Short title that summarizes the requirement. */
  title: string;
  /** The original requirement, verbatim, for traceability. */
  requirement: string;
  /** High-level approach in 2-4 sentences. */
  approach: string;
  /** Target package, e.g. 'ZMY_PROJECT'. */
  targetPackage: string;
  /** Object name prefix the team is using. */
  namespace: AbapNamespace;
  /** Concrete ABAP objects to create or modify. */
  artifacts: Artifact[];
  /** Optional non-functional considerations: auth, performance, transport. */
  considerations?: SpecConsideration[];
  /** Known risks, open questions, dependencies on released APIs. */
  risks?: string[];
  /** Suggested implementation order. */
  steps?: ImplementationStep[];
}

export type ArtifactKind =
  | 'cds-interface' // ZI_*  — basic interface view
  | 'cds-composite' // ZC_*  — composite / aggregated view
  | 'cds-projection' // ZP_*  — projection for service
  | 'cds-extension' // extends an existing released CDS
  | 'access-control' // DCL  — authorization
  | 'behavior-definition' // BDEF — RAP behavior
  | 'behavior-implementation' // CLAS implementing the BDEF
  | 'service-definition' // SRVD
  | 'service-binding' // SRVB — OData V4
  | 'class' // CLAS — utility / helper
  | 'interface' // INTF
  | 'table' // TABL — only if no released entity fits
  | 'domain' // DOMA
  | 'data-element'; // DTEL

export interface Artifact {
  kind: ArtifactKind;
  /** Suggested object name, e.g. 'ZI_AIRCRAFT_RENTAL'. */
  name: string;
  /** Short description for @EndUserText.label. */
  description: string;
  /** Underlying source / parent. For CDS: the table or view it reads from. */
  basedOn?: string;
  /** Optional fields/columns the artifact exposes. */
  exposes?: string[];
  /** Specific notes (e.g. 'cardinality 0..* to Booking'). */
  notes?: string;
  /**
   * Optional generated or hand-written source. When present, capituSpecApply
   * uses this for capituDevApplyArtifact. When absent, the skeleton generator
   * tries to produce a sensible default during propose.
   */
  source?: string;
  /**
   * Names of other artifacts this one depends on (must be activated before).
   * Used by capituSpecApply to derive activation order.
   */
  dependsOn?: string[];
}

export interface SpecConsideration {
  area: 'authorization' | 'performance' | 'transport' | 'extensibility' | 'data-quality';
  text: string;
}

export interface ImplementationStep {
  order: number;
  title: string;
  /** Names of artifacts this step creates. */
  artifacts: string[];
  /** Optional concrete capitu-dev tool call hint. */
  capituDevCall?: string;
}

// ---- Serialization ----------------------------------------------------------

const KIND_LABEL: Record<ArtifactKind, string> = {
  'cds-interface': 'Interface View (CDS)',
  'cds-composite': 'Composite View (CDS)',
  'cds-projection': 'Projection View (CDS, exposed)',
  'cds-extension': 'CDS Extension',
  'access-control': 'Access Control (DCL)',
  'behavior-definition': 'Behavior Definition (BDEF)',
  'behavior-implementation': 'Behavior Implementation Class',
  'service-definition': 'Service Definition (SRVD)',
  'service-binding': 'Service Binding (OData V4)',
  class: 'ABAP Class',
  interface: 'ABAP Interface',
  table: 'Database Table',
  domain: 'Domain (DDIC)',
  'data-element': 'Data Element (DDIC)',
};

export function specToMarkdown(spec: TechnicalSpec): string {
  const parts: string[] = [];
  parts.push(`# ${spec.title}`);
  parts.push('');
  parts.push(`> **Requirement:** ${spec.requirement}`);
  parts.push('');
  parts.push(`**Target package:** \`${spec.targetPackage}\``);
  parts.push(`**Namespace:** \`${spec.namespace}*\``);
  parts.push('');
  parts.push('## Approach');
  parts.push(spec.approach);
  parts.push('');

  parts.push('## Artifacts');
  parts.push('');
  parts.push('| # | Kind | Name | Based on | Purpose |');
  parts.push('|---|------|------|----------|---------|');
  spec.artifacts.forEach((a, i) => {
    parts.push(
      `| ${i + 1} | ${KIND_LABEL[a.kind]} | \`${a.name}\` | ${a.basedOn ? `\`${a.basedOn}\`` : '—'} | ${a.description} |`,
    );
  });
  parts.push('');

  for (const a of spec.artifacts) {
    if (!a.exposes && !a.notes) continue;
    parts.push(`### \`${a.name}\``);
    if (a.exposes?.length) {
      parts.push('**Exposed fields:**');
      for (const f of a.exposes) parts.push(`- \`${f}\``);
    }
    if (a.notes) {
      parts.push('');
      parts.push(`*Notes:* ${a.notes}`);
    }
    parts.push('');
  }

  if (spec.considerations?.length) {
    parts.push('## Considerations');
    for (const c of spec.considerations) {
      parts.push(`- **${cap(c.area)}:** ${c.text}`);
    }
    parts.push('');
  }

  if (spec.risks?.length) {
    parts.push('## Risks & open questions');
    for (const r of spec.risks) parts.push(`- ${r}`);
    parts.push('');
  }

  if (spec.steps?.length) {
    parts.push('## Implementation order');
    for (const s of spec.steps) {
      parts.push(
        `${s.order}. **${s.title}** — creates: ${s.artifacts.map((n) => `\`${n}\``).join(', ')}`,
      );
      if (s.capituDevCall) {
        parts.push(`   _Hint:_ \`${s.capituDevCall}\``);
      }
    }
    parts.push('');
  }

  parts.push('---');
  parts.push(
    '_Generated by capitu-spec. Spec is a proposal — validate against tenant via `capituSpecValidate` before implementing._',
  );
  return parts.join('\n');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
}
