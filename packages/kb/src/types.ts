export type DocSource = 'abap-keyword' | 'help-portal' | 'community' | 'github-samples';

export interface DocChunk {
  source: DocSource;
  release?: string;
  url?: string;
  title: string;
  content: string;
  chunkMeta?: Record<string, unknown>;
}

export interface StoredDoc extends DocChunk {
  id: number;
  indexedAt: string;
}

export type LearningKind = 'error-fix' | 'pattern' | 'decision' | 'gotcha';

export interface Learning {
  kind: LearningKind;
  context?: Record<string, unknown>;
  problem: string;
  solution: string;
  sourceAgent: 'capitu-dev' | 'capitu-spec' | 'capitu-docs';
}

export interface StoredLearning extends Learning {
  id: number;
  validatedAt: string | null;
  createdAt: string;
}

export type TenantCatalogType = 'released_api' | 'odata_service' | 'cds_view' | 'feature';

export interface TenantCatalogEntry {
  type: TenantCatalogType;
  name: string;
  releaseContract?: 'C0' | 'C1' | 'C2' | 'C3';
  metadata?: Record<string, unknown>;
}

export interface Trace {
  agent: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  status: 'ok' | 'error';
}

export interface SearchHit {
  id: number;
  title: string;
  content: string;
  source: DocSource;
  release?: string;
  url?: string;
  score: number;
}
