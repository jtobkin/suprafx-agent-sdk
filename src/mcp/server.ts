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
import { SupraFxClient, SupraFxError } from "../client.js";
import { DelegateSigner } from "../signer.js";
import {
  allTools,
  findTool,
  ToolError,
  type ToolContext,
  type GateMode,
} from "./tools.js";
import { loadConfig } from "./config.js";

export interface MCPServerOptions {
  baseUrl?: string;
  delegatePrivKeyHex?: string | null;
  /** Operator's master address — balances and locks live there. */
  masterAddress?: string | null;
  /** `guarded` (default) requires per-call acknowledgement on money tools. */
  mode?: GateMode;
  /** Tool classes to expose: read / trade / cancel. */
  groups?: Set<string>;
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
  const ctx: ToolContext = {
    client,
    signer,
    masterAddress: opts.masterAddress ?? null,
    mode: opts.mode ?? "guarded",
    groups: opts.groups ?? new Set(["read", "trade", "cancel"]),
  };

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
    // The master address can be filled in after the server started (the
    // operator pastes it once they find it). Pick it up on every call —
    // it is not secret and costs nothing to re-read.
    if (cfg.masterAddress) ctx.masterAddress = cfg.masterAddress;
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
      tools: allTools(!!ctx.signer, ctx.groups).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    await refreshSigner();
    const hasSigner = !!ctx.signer;
    const tool = findTool(req.params.name, hasSigner, ctx.groups);
    if (!tool) {
      // Distinguish "no such tool" from "the operator did not expose it" —
      // different problems with different fixes.
      const knownToSdk = findTool(req.params.name, true);
      return mcpError(
        knownToSdk
          ? {
              code: "TOOL_NOT_EXPOSED",
              detail:
                `${req.params.name} exists but this server was launched with ` +
                `--tools=${[...(ctx.groups ?? [])].join(",")}`,
              remedy: "the OPERATOR must relaunch the server with the class you need",
            }
          : {
              code: "UNKNOWN_TOOL",
              detail: `no tool named ${req.params.name}`,
              remedy: "call `tools/list` and use a name from it",
            },
      );
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {}, ctx);
      if (isRejectedEnvelope(result)) {
        return mcpError(envelopeError(result));
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, jsonReplacer, 2),
          },
        ],
      };
    } catch (e) {
      return mcpError(normalizeError(e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[suprafx-mcp] connected (delegate=${ctx.signer?.addressHex ?? "none"}, ` +
      `master=${ctx.masterAddress ?? "unset"}, mode=${ctx.signer ? ctx.mode : "read_only"}, ` +
      `tools=${[...(ctx.groups ?? ["read","trade","cancel"])].join("+")}, base=${opts.baseUrl ?? "https://suprafx.ai"}, ` +
      `hot-reload=on)\n`,
  );
}

interface ActionableError {
  code: string;
  detail: string;
  remedy: string;
}

function isRejectedEnvelope(value: unknown): value is {
  ok: false;
  code?: string;
  detail?: string;
} {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function envelopeError(result: { code?: string; detail?: string }): ActionableError {
  const upstream = result.code ? `${result.code}: ` : "";
  const detail = result.detail ?? "the venue rejected the signed envelope";
  if (/sequence|replay|strict.next|high.water/i.test(`${result.code ?? ""} ${detail}`)) {
    return {
      code: "SEQUENCE_MISMATCH",
      detail: upstream + detail,
      remedy: "run `get_setup_status`, re-fetch the delegate sequence number, then retry",
    };
  }
  return {
    code: "ENVELOPE_REJECTED",
    detail: upstream + detail,
    remedy: "run `get_setup_status`, fix the reported policy or balance issue, then retry",
  };
}

/**
 * Remedy sentence for each `SupraFxError.action`. The client layer
 * classifies failures by CATEGORY (auth / rate_limit / seq_desync / …);
 * this turns that category into the same `{code, detail, remedy}` shape
 * every other error already uses, so an agent sees ONE envelope no
 * matter which layer failed.
 */
const ACTION_REMEDY: Record<string, string> = {
  authenticate: "this read needs an authorized caller — ask the operator; do not retry in a loop",
  backoff: "back off exponentially and retry; do NOT loop",
  fix_input: "correct the input named in detail, then retry",
  reconnect: "reconnect the MCP server to re-anchor the delegate sequence, then retry",
  configure_key:
    "configure the delegate key (`suprafx-mcp init` or SUPRAFX_DELEGATE_PRIV_HEX) and RECONNECT",
  acknowledge: "re-send the identical call with `acknowledged: true`",
  retry: "retry once; if it persists, report it",
  report:
    "do NOT retry blindly — read state back (`get_balances`, `list_my_open_orders`) and report",
};

function normalizeError(e: unknown): ActionableError {
  if (e instanceof ToolError) {
    return { code: e.code, detail: e.detail, remedy: e.remedy };
  }
  if (e instanceof SupraFxError) {
    return {
      code: e.code.toUpperCase(),
      detail: e.message,
      remedy: ACTION_REMEDY[e.action] ?? "run `get_setup_status`, then retry",
    };
  }
  const detail = e instanceof Error ? e.message : String(e);
  if (
    e instanceof TypeError ||
    /fetch|network|timed? ?out|abort|ECONN|ENOTFOUND|GET \/api|POST \/api/i.test(detail)
  ) {
    return {
      code: "NETWORK_FAILURE",
      detail,
      remedy: "run `get_setup_status`, verify SUPRAFX_BASE_URL and connectivity, then retry",
    };
  }
  return {
    code: "TOOL_EXECUTION_FAILED",
    detail,
    remedy: "run `get_setup_status`, correct the tool inputs shown in detail, then retry",
  };
}

function mcpError(error: ActionableError) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(error, null, 2),
      },
    ],
  };
}

/** JSON.stringify replacer that handles BigInt and Uint8Array. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return "0x" + Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return value;
}
