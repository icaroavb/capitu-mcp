/**
 * Generates ABAP/CDS source skeletons from Artifact metadata.
 *
 * Why a generator: in the original capitu-spec, the LLM had to invent source
 * code for every artifact. That meant 6 chances to misspell an annotation or
 * forget a clause. By emitting canonical templates here, we guarantee the
 * RAP-conformant shape and let the LLM fill in only fields/joins.
 *
 * Each generator returns `null` when it cannot produce a useful skeleton
 * (e.g. behavior implementation classes need code we won't auto-generate).
 * The caller decides whether to leave the artifact for the LLM or to skip.
 */

import type { Artifact } from './spec-model.js';

export interface SkeletonResult {
  source: string;
  generator: string;
  notes: string[];
  /** Whether at least one <SOURCE_FIELD> placeholder remains. */
  hasPlaceholders: boolean;
}

/**
 * Optional resolved field mapping. Keys are alias names from exposes[],
 * values are real column names from the base view (or null if unresolved).
 * When provided, the generator replaces <SOURCE_FIELD> placeholders with
 * real columns wherever possible.
 */
export type FieldMap = Record<string, string | null>;

export function generateSkeleton(art: Artifact, fields?: FieldMap): SkeletonResult | null {
  switch (art.kind) {
    case 'cds-interface':
      return generateCdsInterface(art, fields);
    case 'cds-composite':
      return generateCdsComposite(art, fields);
    case 'cds-projection':
      return generateCdsProjection(art);
    case 'cds-extension':
      return generateCdsExtension(art);
    case 'access-control':
      return generateDcl(art);
    case 'service-definition':
      return generateServiceDefinition(art);
    case 'service-binding':
      return null;
    case 'behavior-definition':
      return generateBehaviorDefinition(art);
    case 'behavior-implementation':
      return null;
    default:
      return null;
  }
}

// ---- CDS Interface ----------------------------------------------------------

function generateCdsInterface(art: Artifact, fields?: FieldMap): SkeletonResult {
  const notes: string[] = [];
  if (!art.basedOn) {
    notes.push(
      'No basedOn declared. Source uses a placeholder — replace <SOURCE_TABLE_OR_VIEW> before writing.',
    );
  }
  const fieldsBlock = buildFieldsBlock(art.exposes, '      ', notes, art.basedOn, false, fields);
  const source = `@AbapCatalog.viewEnhancementCategory: [#NONE]
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: '${escapeLabel(art.description)}'
@Metadata.ignorePropagatedAnnotations: true
@ObjectModel.usageType.serviceQuality: #D
@ObjectModel.usageType.sizeCategory: #S
@ObjectModel.usageType.dataClass: #MIXED
define view entity ${art.name} as
  select from ${art.basedOn ?? '<SOURCE_TABLE_OR_VIEW>'}
{${fieldsBlock}
}
`;
  return {
    source,
    generator: 'cds-interface@v1',
    notes,
    hasPlaceholders: source.includes('<SOURCE_FIELD>') || source.includes('<SOURCE_TABLE_OR_VIEW>'),
  };
}

// ---- CDS Composite ---------------------------------------------------------

function generateCdsComposite(art: Artifact, fields?: FieldMap): SkeletonResult {
  const notes: string[] = [];
  if (!art.basedOn) {
    notes.push('Composite without basedOn — must be edited to add the underlying interface view.');
  }
  // Composite reads from an interface that already has the camelCase aliases
  // — so prefer 1:1 (alias as alias) rather than re-mapping <SOURCE_FIELD>.
  const fieldsBlock = buildCompositeFieldsBlock(art.exposes, '      ', notes, fields);
  const source = `@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: '${escapeLabel(art.description)}'
@Metadata.ignorePropagatedAnnotations: true
@ObjectModel.usageType.serviceQuality: #D
@ObjectModel.usageType.sizeCategory: #S
@ObjectModel.usageType.dataClass: #MIXED
define view entity ${art.name} as
  select from ${art.basedOn ?? '<INTERFACE_VIEW>'}
{${fieldsBlock}
}
`;
  return {
    source,
    generator: 'cds-composite@v1',
    notes,
    hasPlaceholders: source.includes('<SOURCE_FIELD>') || source.includes('<INTERFACE_VIEW>'),
  };
}

// ---- CDS Projection --------------------------------------------------------

function generateCdsProjection(art: Artifact): SkeletonResult {
  const notes: string[] = [];
  if (!art.basedOn) {
    notes.push('Projection requires basedOn (the composite or interface to project). Edit before writing.');
  }
  const source = `@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: '${escapeLabel(art.description)}'
@Metadata.allowExtensions: true
@Search.searchable: true
define root view entity ${art.name}
  provider contract transactional_query
  as projection on ${art.basedOn ?? '<COMPOSITE_OR_INTERFACE>'}
{${buildFieldsBlock(art.exposes, '      ', notes, art.basedOn, /* projection */ true)}
}
`;
  return {
    source,
    generator: 'cds-projection@v1',
    notes,
    hasPlaceholders: source.includes('<COMPOSITE_OR_INTERFACE>') || source.includes('<KEY_FIELD>'),
  };
}

// ---- CDS Extension ---------------------------------------------------------

function generateCdsExtension(art: Artifact): SkeletonResult {
  const notes: string[] = [
    'Extension annotations must match the base view contract. Review before activating.',
  ];
  const source = `@EndUserText.label: '${escapeLabel(art.description)}'
extend view entity ${art.basedOn ?? '<BASE_RELEASED_VIEW>'} with ${art.name}
{
  // add fields here
}
`;
  return { source, generator: 'cds-extension@v1', notes, hasPlaceholders: !art.basedOn };
}

// ---- DCL (Access Control) --------------------------------------------------

function generateDcl(art: Artifact): SkeletonResult {
  const notes: string[] = [
    'Placeholder DCL grants all access. Replace with real authorization aspect (e.g. PFCG, structural).',
  ];
  const protectedView = art.basedOn ?? '<PROTECTED_VIEW>';
  const source = `@EndUserText.label: '${escapeLabel(art.description)}'
@MappingRole: true
define role ${art.name} {
  grant select on ${protectedView};
}
`;
  return { source, generator: 'dcl@v1', notes, hasPlaceholders: !art.basedOn };
}

// ---- Service Definition ----------------------------------------------------

function generateServiceDefinition(art: Artifact): SkeletonResult {
  const notes: string[] = [];
  if (!art.basedOn) {
    notes.push('Service definition needs at least one exposed entity (basedOn).');
  }
  const exposed = art.basedOn ?? '<PROJECTION_VIEW>';
  const exposeName = exposed.replace(/^Z[A-Z]_/, '');
  const source = `@EndUserText.label: '${escapeLabel(art.description)}'
define service ${art.name} {
  expose ${exposed} as ${exposeName};
}
`;
  return { source, generator: 'service-definition@v1', notes, hasPlaceholders: !art.basedOn };
}

// ---- Behavior Definition (managed, minimal) -------------------------------

function generateBehaviorDefinition(art: Artifact): SkeletonResult {
  const notes: string[] = [
    'Managed behavior with minimal CRUD. Adjust persistent table, authorization and add actions as needed.',
    'If you need draft, add `draft table z<name>_d` and `with draft` after the implementation clause.',
  ];
  const implClass = `ZBP_${art.name.replace(/^Z[A-Z]_/, '').toUpperCase()}`;
  const alias = art.name.replace(/^Z[A-Z]_/, '').toLowerCase().replace(/_/g, '');
  const source = `managed implementation in class ${implClass.toLowerCase()} unique;
strict ( 2 );

define behavior for ${art.name} alias ${alias}
implementation in class ${implClass.toLowerCase()} unique
persistent table <PERSISTENT_TABLE>
lock master
authorization master ( instance )
{
  create;
  update;
  delete;
}
`;
  return { source, generator: 'behavior-definition@v1', notes, hasPlaceholders: true };
}

// ---- Helpers ---------------------------------------------------------------

function escapeLabel(label: string): string {
  // Keep within EndUserText length (60), strip quotes.
  return label.replace(/'/g, '').slice(0, 60);
}

function buildFieldsBlock(
  exposes: string[] | undefined,
  indent: string,
  notes: string[],
  basedOn: string | undefined,
  projection = false,
  fields?: FieldMap,
): string {
  if (!exposes || exposes.length === 0) {
    notes.push(
      'No exposes[] declared. Source has a placeholder field list — fill it before writing.',
    );
    return `\n${indent}key <KEY_FIELD>,\n${indent}<OTHER_FIELDS>`;
  }

  let unresolvedCount = 0;
  const lines = exposes.map((alias, idx) => {
    const isKey = idx === 0;
    if (projection) {
      // Projection: just key Alias / Alias
      return `${indent}${isKey ? 'key ' : ''}${alias}`;
    }
    // Interface/composite: `key src_col as Alias`
    const resolved = fields?.[alias];
    const sourceCol = resolved ?? '<SOURCE_FIELD>';
    if (!resolved) unresolvedCount++;
    return `${indent}${isKey ? 'key ' : ''}${sourceCol} as ${alias}`;
  });

  if (!projection && basedOn) {
    if (unresolvedCount === 0 && fields) {
      notes.push(
        `Field source columns resolved from ${basedOn} via ADT — no placeholders remain.`,
      );
    } else if (unresolvedCount > 0 && fields) {
      notes.push(
        `${unresolvedCount}/${exposes.length} field(s) kept as <SOURCE_FIELD>: ${exposes
          .filter((a) => !fields[a])
          .join(', ')}. Replace before activating.`,
      );
    } else if (!fields) {
      notes.push(
        `Field source columns are placeholders (<SOURCE_FIELD>) — capitu did not attempt field resolution. Replace with real column names from ${basedOn}.`,
      );
    }
  }
  return `\n${lines.join(',\n')}`;
}

/**
 * Composite views read from interfaces that ALREADY have the camelCase aliases,
 * so the conventional shape is `field as field` (1:1), not `<SOURCE_FIELD> as field`.
 * Resolver may still produce a real source name if the column happens to differ.
 */
function buildCompositeFieldsBlock(
  exposes: string[] | undefined,
  indent: string,
  notes: string[],
  fields?: FieldMap,
): string {
  if (!exposes || exposes.length === 0) {
    notes.push('No exposes[] declared — placeholder field list.');
    return `\n${indent}key <KEY_FIELD>,\n${indent}<OTHER_FIELDS>`;
  }
  const lines = exposes.map((alias, idx) => {
    const isKey = idx === 0;
    const resolved = fields?.[alias];
    // For composite-on-interface, default to alias=alias (idempotent rename).
    const sourceCol = resolved ?? alias;
    return `${indent}${isKey ? 'key ' : ''}${sourceCol}`;
  });
  return `\n${lines.join(',\n')}`;
}
