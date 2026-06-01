/**
 * MCP server wiring. Translates the `@modelcontextprotocol/sdk` tool
 * lifecycle into calls against our handlers in `./tools.ts`.
 *
 * Transport: stdio (default for Claude Desktop, Cursor, Continue).
 * The client launches `suprafx-mcp` as a subprocess and pipes JSON-RPC
 * over stdin/stdout. No network listener on this side.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SupraFxClient } from "../client.js";
import { DelegateSigner } from "../signer.js";
import { allTools, findTool, type ToolContext } from "./tools.js";

export interface MCPServerOptions {
  baseUrl?: string;
  delegatePrivKeyHex?: string | null;
}

export async function runMCPServer(opts: MCPServerOptions = {}): Promise<void> {
  const client = new SupraFxClient({ baseUrl: opts.baseUrl });
  let signer: DelegateSigner | null = null;
  if (opts.delegatePrivKeyHex) {
    signer = new DelegateSigner({
      delegatePrivKeyHex: opts.delegatePrivKeyHex,
      client,
    });
    // Anchor the signer's seq counter to chain at startup.
    try {
      await signer.loadSequenceFromChain();
    } catch (e) {
      // Log to stderr; signer is still usable, just with seq=0.
      process.stderr.write(
        `[suprafx-mcp] warning: loadSequenceFromChain failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  const ctx: ToolContext = { client, signer };
  const hasSigner = !!signer;

  const server = new Server(
    { name: "suprafx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools(hasSigner).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = findTool(req.params.name, hasSigner);
    if (!tool) {
      throw new Error(
        `Unknown tool: ${req.params.name}${
          !hasSigner ? " (write tools require a delegate key — run `suprafx-mcp init`)" : ""
        }`,
      );
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {}, ctx);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, jsonReplacer, 2),
          },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[suprafx-mcp] connected (delegate=${hasSigner ? signer!.addressHex : "none"}, base=${opts.baseUrl ?? "https://suprafx.ai"})\n`,
  );
}

/** JSON.stringify replacer that handles BigInt and Uint8Array. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return "0x" + Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return value;
}
