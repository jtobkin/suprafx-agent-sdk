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
import { loadConfig } from "./config.js";

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

  // HOT-RELOAD of the delegate key. The key in `~/.suprafx/config.json`
  // (or env) can be rotated while this long-lived stdio server runs. Without
  // this, the signer built above is frozen for the life of the process, so
  // after a rotation `get_my_identity` reports the stale delegate and writes
  // sign with a stale (possibly revoked / 0-cap) key — silently. We re-read
  // the config before every tool request and rebuild the signer ONLY when the
  // resolved delegate key actually changes (re-anchoring its chain sequence).
  // Steady-state cost is one small file read + string compare per call.
  let currentKey: string | null = opts.delegatePrivKeyHex ?? null;
  let refreshing: Promise<void> | null = null;
  // Single-flight: collapse concurrent tool-call refreshes into one, so an
  // interleaved rotation can't trigger redundant rebuilds / racing chain reads.
  function refreshSigner(): Promise<void> {
    if (!refreshing) {
      refreshing = doRefreshSigner().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }
  async function doRefreshSigner(): Promise<void> {
    const cfg = loadConfig();
    if (cfg.delegatePrivKeyHex === currentKey) return; // unchanged — fast path
    const oldAddr = ctx.signer?.addressHex ?? "none";
    if (cfg.delegatePrivKeyHex) {
      const next = new DelegateSigner({
        delegatePrivKeyHex: cfg.delegatePrivKeyHex,
        client,
      });
      try {
        await next.loadSequenceFromChain();
      } catch (e) {
        // Anchoring the new delegate's chain sequence failed (network blip).
        // Do NOT install a seq-0 signer — it would replay-drop trades
        // silently — and do NOT advance currentKey. Go read-only and retry
        // the rebuild+anchor on the next tool call. Fails closed: safer than
        // signing with a stale/old key after the operator rotated.
        ctx.signer = null;
        process.stderr.write(
          `[suprafx-mcp] warning: anchoring rotated delegate failed (${e instanceof Error ? e.message : String(e)}); staying read-only, will retry on next call\n`,
        );
        return; // currentKey unchanged → retried next call
      }
      ctx.signer = next;
    } else {
      ctx.signer = null; // delegate removed → back to read-only
    }
    currentKey = cfg.delegatePrivKeyHex;
    process.stderr.write(
      `[suprafx-mcp] delegate refreshed from config: ${oldAddr} -> ${ctx.signer?.addressHex ?? "none"}\n`,
    );
  }

  const server = new Server(
    { name: "suprafx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await refreshSigner();
    return {
      tools: allTools(!!ctx.signer).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    await refreshSigner();
    const hasSigner = !!ctx.signer;
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
    `[suprafx-mcp] connected (delegate=${ctx.signer?.addressHex ?? "none"}, base=${opts.baseUrl ?? "https://suprafx.ai"}, hot-reload=on)\n`,
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
