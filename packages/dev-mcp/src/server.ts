#!/usr/bin/env node
import { CompliancePolicyViolation, isToolEnabled } from '@capitu/kb';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type ServerContext, buildContext, shutdownContext } from './context.js';
import { zodToJsonSchema } from './schema.js';
import { runTool } from './tool.js';
import { ALL_TOOLS } from './tools/index.js';

/**
 * Instance-management tools are NEVER hidden by tool-visibility config —
 * hiding them would lock the user out of switching/inspecting instances.
 */
function isAlwaysOnTool(name: string): boolean {
  return (
    name.endsWith('ListInstances') || name.endsWith('WhichInstance') || name.endsWith('UseInstance')
  );
}

/** A tool is exposed unless the instances.json `tools` map disables it. */
function toolExposed(name: string, visibility?: Record<string, boolean>): boolean {
  if (isAlwaysOnTool(name)) return true;
  return isToolEnabled(name, visibility);
}

const VERSION = '0.0.1';

export async function main(): Promise<void> {
  let ctx: ServerContext;
  try {
    ctx = buildContext();
  } catch (err) {
    process.stderr.write(
      `[capitu-dev] startup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const server = new Server(
    { name: 'capitu-dev', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ALL_TOOLS.filter((t) => toolExposed(t.name, ctx.toolVisibility)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = ALL_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
      };
    }
    // Defense in depth: a disabled tool must not run even if called directly.
    if (!toolExposed(tool.name, ctx.toolVisibility)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Tool '${tool.name}' is disabled via instances.json "tools" config.`,
          },
        ],
      };
    }
    try {
      const result = await runTool(
        tool as unknown as Parameters<typeof runTool>[0],
        req.params.arguments ?? {},
        ctx,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const text =
        err instanceof CompliancePolicyViolation
          ? `[compliance] ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { isError: true, content: [{ type: 'text', text }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    await shutdownContext(ctx);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // The banner peeks at the write gate, which resolves the ACTIVE instance —
  // and that throws when no instance is configured yet. A missing config must
  // not kill the server (docs/spec stay up in that state; tools surface the
  // configuration error per call), so degrade the banner instead of crashing.
  let writesNote: string;
  try {
    writesNote = ctx.writes.allowed
      ? `writes ENABLED (allowlist: ${ctx.writes.allowedPackages.join(', ')})`
      : 'writes DISABLED (set CAPITU_ALLOW_WRITES=true to enable)';
  } catch (err) {
    writesNote = `no SAP instance configured yet — tools will error until one is set up (${
      err instanceof Error ? err.message : String(err)
    })`;
  }
  process.stderr.write(
    `[capitu-dev] v${VERSION} ready (${ALL_TOOLS.length} tools, ${writesNote})\n`,
  );
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js');

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[capitu-dev] fatal: ${err}\n`);
    process.exit(1);
  });
}
