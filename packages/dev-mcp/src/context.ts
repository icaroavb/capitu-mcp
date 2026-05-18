import { CapituAdtClient } from '@capitu/adt-client';
import {
  type ComplianceContext,
  type EmbeddingsProvider,
  loadComplianceFromEnv,
  openKb,
  resolveEmbeddingsProvider,
} from '@capitu/kb';
import type { Database } from 'better-sqlite3';

/**
 * ServerContext for capitu-dev.
 *
 * The shape mirrors @capitu/docs-mcp's context — same KB, same compliance gate,
 * same embeddings — but the agent identifier differs so that traces and
 * learnings recorded from dev are attributable.
 *
 * Plus: a writes-allowed flag and a package allowlist used by write tools.
 */
export interface ServerContext {
  kb: Database;
  embeddings: EmbeddingsProvider;
  adt: CapituAdtClient;
  compliance: ComplianceContext;
  agent: 'capitu-dev';
  writes: {
    allowed: boolean;
    allowedPackages: string[]; // glob-ish patterns: '$TMP', 'Z*', 'ZSANDBOX_PKG'
  };
}

export interface ServerContextOptions {
  kbPath?: string;
  embeddings?: EmbeddingsProvider;
}

export function buildContext(opts: ServerContextOptions = {}): ServerContext {
  const url = required('SAP_URL');
  const user = required('SAP_USER');
  const password = required('SAP_PASSWORD');
  const client = process.env.SAP_CLIENT;
  const language = process.env.SAP_LANGUAGE;

  const adt = new CapituAdtClient({ url, user, password, client, language });
  const kb = openKb({ path: opts.kbPath });
  const embeddings = opts.embeddings ?? resolveEmbeddingsProvider();
  const compliance = loadComplianceFromEnv();

  const writesAllowed = process.env.CAPITU_ALLOW_WRITES === 'true';
  const allowedPackages = (process.env.CAPITU_ALLOWED_PACKAGES ?? '$TMP')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    kb,
    embeddings,
    adt,
    compliance,
    agent: 'capitu-dev',
    writes: { allowed: writesAllowed, allowedPackages },
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `capitu-dev: required env var ${name} is missing. ADT connection is mandatory.`,
    );
  }
  return v;
}

export async function shutdownContext(ctx: ServerContext): Promise<void> {
  try {
    await ctx.adt.disconnect();
  } catch {
    // best-effort
  }
  try {
    ctx.kb.close();
  } catch {
    // best-effort
  }
}

/**
 * Tests whether a package name matches one of the configured allowlist patterns.
 * Patterns support a single trailing '*' wildcard (e.g. 'Z*' matches 'ZFOO', 'ZBAR').
 * Exact match also works ('$TMP' matches only '$TMP').
 */
export function isPackageAllowed(packageName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      if (packageName.startsWith(prefix)) return true;
    } else if (packageName === p) {
      return true;
    }
  }
  return false;
}
