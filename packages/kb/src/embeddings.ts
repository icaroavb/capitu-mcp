import { EMBEDDING_DIM } from './schema.js';
import { envValue } from './winenv.js';

export interface EmbeddingsProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dim: number;
  readonly model: string;
}

export interface VoyageOptions {
  apiKey?: string;
  model?: 'voyage-3-lite' | 'voyage-3' | 'voyage-3-large';
  inputType?: 'document' | 'query';
}

/**
 * Voyage AI embeddings provider. Default model voyage-3-lite produces 512-dim vectors
 * matching the schema's EMBEDDING_DIM. Set VOYAGE_API_KEY in env.
 */
export class VoyageEmbeddings implements EmbeddingsProvider {
  readonly dim = EMBEDDING_DIM;
  readonly model: string;
  private readonly apiKey: string;
  private readonly inputType: 'document' | 'query';

  constructor(opts: VoyageOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'VoyageEmbeddings: VOYAGE_API_KEY env var not set. Create a key at ' +
          'https://voyageai.com (free tier: 200M tokens for indexing).',
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? 'voyage-3-lite';
    this.inputType = opts.inputType ?? 'document';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        input_type: this.inputType,
        output_dimension: this.dim,
      }),
    });
    if (!res.ok) {
      throw new Error(`Voyage API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

/**
 * No-op provider that returns no vectors. Capitu falls back to BM25-only
 * search (FTS5) when this provider is active.
 *
 * Use case: distributing capitu to users who can't or won't configure an
 * embeddings API (Voyage/OpenAI) and whose network blocks huggingface.co.
 * Semantic recall stops working but every other tool keeps functioning —
 * learnings are still recorded, search still returns keyword matches.
 */
export class NullEmbeddings implements EmbeddingsProvider {
  readonly dim = 0;
  readonly model = 'null';

  async embed(texts: string[]): Promise<number[][]> {
    // Return empty vectors so callers can detect "no embedding" cheaply.
    return texts.map(() => []);
  }
}

/**
 * Picks the embeddings provider based on env vars, with sensible fallbacks.
 *
 * Priority:
 *   1. CAPITU_EMBEDDINGS=voyage  -> VoyageEmbeddings (requires VOYAGE_API_KEY)
 *   2. CAPITU_EMBEDDINGS=local   -> LocalEmbeddings  (requires HF reachability)
 *   3. CAPITU_EMBEDDINGS=bm25    -> NullEmbeddings   (FTS5-only, zero deps)
 *   4. VOYAGE_API_KEY set        -> VoyageEmbeddings (auto-detected)
 *   5. fallback                  -> NullEmbeddings  (BM25-only, never crashes startup)
 *
 * Rationale for the fallback change: previously we fell back to LocalEmbeddings
 * which requires huggingface.co. In corporate networks where HF is blocked,
 * any tool that needed an embedding would crash on first use. NullEmbeddings
 * is always safe — every tool keeps working, just without semantic search.
 */
export function resolveEmbeddingsProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingsProvider {
  const choice = envValue(env, 'CAPITU_EMBEDDINGS')?.toLowerCase();
  if (choice === 'voyage') return new VoyageEmbeddings();
  if (choice === 'local') return new LocalEmbeddings();
  if (choice === 'bm25' || choice === 'none' || choice === 'null') return new NullEmbeddings();
  if (envValue(env, 'VOYAGE_API_KEY')) return new VoyageEmbeddings();
  return new NullEmbeddings();
}

/**
 * Local embeddings via @xenova/transformers (Hugging Face Transformers.js).
 *
 * First call downloads the model (~90 MB for all-MiniLM-L6-v2) into the
 * Transformers.js cache (default ~/.cache/huggingface/). After that it runs
 * fully offline on CPU.
 *
 * Why this default: zero API key, zero recurring cost, works without internet
 * after warmup, decent quality for technical docs. Used by mcp-sap-docs (176 stars).
 */
export interface LocalEmbeddingsOptions {
  /** Hugging Face model id. Default produces 384-dim vectors. */
  model?: 'Xenova/all-MiniLM-L6-v2' | 'Xenova/bge-small-en-v1.5';
  /** Optional cache dir override. */
  cacheDir?: string;
}

type PipelineFn = (
  texts: string | string[],
  opts?: { pooling: 'mean' | 'cls'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

export class LocalEmbeddings implements EmbeddingsProvider {
  readonly dim = EMBEDDING_DIM;
  readonly model: string;
  private pipeline: PipelineFn | null = null;
  private readonly cacheDir?: string;

  constructor(opts: LocalEmbeddingsOptions = {}) {
    this.model = opts.model ?? 'Xenova/all-MiniLM-L6-v2';
    this.cacheDir = opts.cacheDir;
  }

  private async ensurePipeline(): Promise<PipelineFn> {
    if (this.pipeline) return this.pipeline;
    // Lazy import: avoids loading transformers when tests use FakeEmbeddings,
    // AND lets @xenova/transformers be an OPTIONAL dependency — bm25/voyage users
    // never download its ~45 MB. If 'local' mode is selected without the package
    // installed, fail with an actionable message instead of a raw module error.
    let transformers: typeof import('@xenova/transformers');
    try {
      transformers = await import('@xenova/transformers');
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'CAPITU_EMBEDDINGS=local requires the optional package @xenova/transformers, ' +
            'which is not installed. Run `npm install @xenova/transformers` (≈45 MB), ' +
            'or use CAPITU_EMBEDDINGS=bm25 (zero download) or voyage.',
        );
      }
      throw err;
    }
    if (this.cacheDir) {
      (transformers.env as { cacheDir?: string }).cacheDir = this.cacheDir;
    }
    const fn = (await transformers.pipeline(
      'feature-extraction',
      this.model,
    )) as unknown as PipelineFn;
    this.pipeline = fn;
    return fn;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.ensurePipeline();
    const out: number[][] = [];
    for (const text of texts) {
      const result = await pipe(text, { pooling: 'mean', normalize: true });
      const arr = Array.from(result.data);
      if (arr.length !== this.dim) {
        throw new Error(
          `LocalEmbeddings: model returned ${arr.length} dims, expected ${this.dim}. Re-create the KB with a matching EMBEDDING_DIM.`,
        );
      }
      out.push(arr);
    }
    return out;
  }
}

/**
 * Deterministic fake provider for unit tests — never call out to a real API in tests.
 * Hashes input into a fixed-dim vector. Not a real embedding; only stable across runs.
 */
export class FakeEmbeddings implements EmbeddingsProvider {
  readonly dim = EMBEDDING_DIM;
  readonly model = 'fake-deterministic';

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.hash(t));
  }

  private hash(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      vec[(c + i) % this.dim] += ((c * 13 + 7) % 100) / 100;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}
