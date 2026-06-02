#!/usr/bin/env node
import { CompliancePolicyViolation, isToolEnabled } from '@capitu/kb';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type ServerContext, buildContext, shutdownContext } from './context.js';
import { zodToJsonSchema } from './schema.js';
import { runTool } from './tool.js';
import { ALL_TOOLS } from './tools/index.js';

const VERSION = '0.0.1';

/** Instance-management tools are never hidden — hiding them locks the user out. */
function isAlwaysOnTool(name: string): boolean {
  return (
    name.endsWith('ListInstances') ||
    name.endsWith('WhichInstance') ||
    name.endsWith('UseInstance')
  );
}

function toolExposed(name: string, visibility?: Record<string, boolean>): boolean {
  if (isAlwaysOnTool(name)) return true;
  return isToolEnabled(name, visibility);
}

export async function main(): Promise<void> {
  let ctx: ServerContext;
  try {
    ctx = buildContext();
  } catch (err) {
    process.stderr.write(
      `[capitu-spec] startup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const server = new Server(
    { name: 'capitu-spec', version: VERSION },
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
    if (!toolExposed(tool.name, ctx.toolVisibility)) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Tool '${tool.name}' is disabled via instances.json "tools" config.` },
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

  process.stderr.write(`[capitu-spec] v${VERSION} ready (${ALL_TOOLS.length} tools)\n`);
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js');

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[capitu-spec] fatal: ${err}\n`);
    process.exit(1);
  });
}
