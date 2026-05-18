import type { Database } from 'better-sqlite3';
import type { Trace } from './types.js';

export function recordTrace(db: Database, trace: Trace): void {
  db.prepare(
    `INSERT INTO traces (agent, tool, input, output, duration_ms, status)
     VALUES (@agent, @tool, @input, @output, @durationMs, @status)`,
  ).run({
    agent: trace.agent,
    tool: trace.tool,
    input: trace.input === undefined ? null : JSON.stringify(trace.input),
    output: trace.output === undefined ? null : JSON.stringify(trace.output),
    durationMs: trace.durationMs ?? null,
    status: trace.status,
  });
}

export async function withTrace<T>(
  db: Database,
  agent: string,
  tool: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const out = await fn();
    recordTrace(db, {
      agent,
      tool,
      input,
      output: out,
      durationMs: Date.now() - start,
      status: 'ok',
    });
    return out;
  } catch (err) {
    recordTrace(db, {
      agent,
      tool,
      input,
      output: { error: err instanceof Error ? err.message : String(err) },
      durationMs: Date.now() - start,
      status: 'error',
    });
    throw err;
  }
}
