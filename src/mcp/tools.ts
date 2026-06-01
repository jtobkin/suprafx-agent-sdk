/**
 * MCP tool definitions + handlers for SupraFX.
 *
 * Split into READ tools (always available) and WRITE tools (only
 * available when a delegate key is configured). Each tool's input
 * schema is hand-written to match the JSON the model passes; the
 * handler converts human-friendly inputs (e.g. `size: 0.5` for 0.5
 * ETH) into the chain's wire encoding internally.
 *
 * Reference: docs/INTEGRATING-AGENTS.md
 */

import type {
  SupraFxClient,
  AssetInfo,
} from "../client.js";
import type { DelegateSigner } from "../signer.js";
import {
  deriveAssetId,
  derivePairIdFromTokens,
} from "../derive-ids.js";
import { toMicroUnits, toRateBFT } from "../asset-registry.js";

export interface ToolContext {
  client: SupraFxClient;
  /** Present only when a delegate key is configured. */
  signer: DelegateSigner | null;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  /** Requires a configured delegate key (write tool). */
  requiresSigner: boolean;
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

// ─── Read tools ────────────────────────────────────────────────

const readTools: ToolDef[] = [
  {
    name: "get_chain_info",
    description:
      "Return the SupraFX chain identifier hash, threshold, and chain ID. " +
      "Use to verify which chain you're connected to.",
    inputSchema: { type: "object", properties: {} },
    requiresSigner: false,
    handler: async (_args, ctx) => await ctx.client.getChainInfo(),
  },
  {
    name: "get_current_batch",
    description:
      "Return the current committed batch height. Useful as a chain " +
      "health probe (advancing = chain alive) and for `expires_at_batch` " +
      "math when bootstrapping delegate sessions.",
    inputSchema: { type: "object", properties: {} },
    requiresSigner: false,
    handler: async (_args, ctx) => ({ current_batch: await ctx.client.getCurrentBatch() }),
  },
  {
    name: "get_sequence_number",
    description:
      "Return the next strictly-monotonic sequence number an account " +
      "must use for its next signed event. Pass the master's address " +
      "for master events, the delegate's address for trade events.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description:
            "0x-prefixed 32-byte Supra address (master or delegate)",
        },
      },
      required: ["address"],
    },
    requiresSigner: false,
    handler: async (args, ctx) => ({
      next_sequence_number: await ctx.client.getSequenceNumber(args.address),
    }),
  },
  {
    name: "list_assets",
    description:
      "List all supported assets on the chain. Returns chain_id, " +
      "asset_symbol, contract address (null for native), and decimals.",
    inputSchema: { type: "object", properties: {} },
    requiresSigner: false,
    handler: async (_args, ctx) => ({ assets: await ctx.client.listAssets() }),
  },
  {
    name: "get_balances",
    description:
      "Return the master's available + locked balances per asset. " +
      "Pass the master's Supra address (NOT the delegate's — delegates " +
      "have no balances of their own).",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "0x-prefixed 32-byte master Supra address",
        },
      },
      required: ["address"],
    },
    requiresSigner: false,
    handler: async (args, ctx) => ({
      balances: await ctx.client.getBalances(args.address),
    }),
  },
  {
    name: "get_orderbook",
    description:
      "Return the current public orderbook of open RFQs. Filter by " +
      "pair (e.g. 'ETH/USDC') or status. Returns up to `limit` rows.",
    inputSchema: {
      type: "object",
      properties: {
        pair: { type: "string", description: "Pair filter, e.g. 'ETH/USDC'" },
        status: {
          type: "string",
          description:
            "Status filter. Default 'open' — also accepts 'matched', 'cancelled', 'expired'",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 50, cap 200)",
        },
      },
    },
    requiresSigner: false,
    handler: async (args, ctx) => ({
      rfqs: await ctx.client.getOrderbook({
        pair: args.pair,
        status: args.status ?? "open",
        limit: args.limit ?? 50,
      }),
    }),
  },
  {
    name: "get_my_identity",
    description:
      "Return the delegate address this MCP server is signing as. " +
      "Available only when a delegate key is configured.",
    inputSchema: { type: "object", properties: {} },
    requiresSigner: false, // read-only but informational
    handler: async (_args, ctx) => {
      if (!ctx.signer) {
        return { delegate_address: null, configured: false };
      }
      return {
        delegate_address: ctx.signer.addressHex,
        next_sequence_number: ctx.signer.getNextSeq().toString(),
        configured: true,
      };
    },
  },
];

// ─── Write tools ───────────────────────────────────────────────

const writeTools: ToolDef[] = [
  {
    name: "submit_rfq",
    description:
      "Sign and submit a SubmitRfq to the chain — become the taker on a " +
      "new RFQ. Locks `size` of `sell_token` from the master's available " +
      "balance. Other agents can quote on this RFQ until it matches, " +
      "expires (30 min default), or is cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        sell_chain: {
          type: "string",
          description:
            "Canonical chain id of the asset you're selling (e.g. 'eth-mainnet', 'supra-mainnet')",
        },
        sell_token: {
          type: "string",
          description: "Symbol of the asset you're selling (e.g. 'ETH', 'USDC')",
        },
        buy_chain: { type: "string", description: "Canonical chain id of the asset you want" },
        buy_token: { type: "string", description: "Symbol of the asset you want" },
        size: {
          type: "number",
          description: "Amount of sell_token to give (human units, e.g. 0.5 for 0.5 ETH)",
        },
        reference_price: {
          type: "number",
          description:
            "Reference rate as buy_token per 1 sell_token (e.g. 2400 for ETH/USDC at $2400)",
        },
        settlement_mode: {
          type: "string",
          enum: ["Platform", "OnChain"],
          description: "Platform (recommended) for fast internal settle, OnChain for L1 settle",
        },
        expires_in_minutes: {
          type: "number",
          description: "Minutes until the RFQ expires (default 30)",
        },
        allow_partial_fills: { type: "boolean", description: "Default false" },
        min_fill_size: {
          type: "number",
          description: "Required if allow_partial_fills=true; minimum acceptable partial fill",
        },
        auto_accept: {
          type: "boolean",
          description: "If true, auto-accept the first quote at or better than auto_accept_target_rate",
        },
        auto_accept_target_rate: { type: "number", description: "Required if auto_accept=true" },
      },
      required: [
        "sell_chain",
        "sell_token",
        "buy_chain",
        "buy_token",
        "size",
        "reference_price",
      ],
    },
    requiresSigner: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      const assets = await ctx.client.listAssets();
      const baseDec = assetDecimals(assets, args.sell_chain, args.sell_token);
      const quoteDec = assetDecimals(assets, args.buy_chain, args.buy_token);
      const baseAsset = deriveAssetId(args.sell_chain, args.sell_token);
      const quoteAsset = deriveAssetId(args.buy_chain, args.buy_token);
      const pair = derivePairIdFromTokens(
        args.sell_chain,
        args.sell_token,
        args.buy_chain,
        args.buy_token,
      );
      const currentBatch = BigInt(await ctx.client.getCurrentBatch());
      const expiresAtMs = BigInt(
        Date.now() + (args.expires_in_minutes ?? 30) * 60 * 1000,
      );
      const allowPartial = !!args.allow_partial_fills;
      return await signer.submitRfq({
        pair,
        base_asset: baseAsset,
        quote_asset: quoteAsset,
        size: toMicroUnits(args.size, baseDec),
        reference_price: toRateBFT(args.reference_price, baseDec, quoteDec),
        auto_accept: !!args.auto_accept,
        auto_accept_target_rate: args.auto_accept
          ? toRateBFT(args.auto_accept_target_rate, baseDec, quoteDec)
          : BigInt(0),
        allow_partial_fills: allowPartial,
        min_fill_size: allowPartial
          ? toMicroUnits(args.min_fill_size ?? 0, baseDec)
          : BigInt(0),
        expires_at_ms: expiresAtMs,
        rfq_id: randomBytes16(),
        settlement_mode:
          args.settlement_mode === "OnChain" ? "OnChain" : "Platform",
      });
    },
  },
  {
    name: "place_quote",
    description:
      "Sign and submit a PlaceQuote on an existing open RFQ — become the maker. " +
      "Locks `total_payment` of the RFQ's quote_asset from your master balance. " +
      "If accepted by the taker, the trade settles.",
    inputSchema: {
      type: "object",
      properties: {
        rfq_id: {
          type: "string",
          description: "UUID (with dashes) of the parent RFQ from the orderbook",
        },
        fill_size: {
          type: "number",
          description:
            "Amount of the RFQ's base_asset you're offering to fill (human units). For a full quote, match rfq.size",
        },
        total_payment: {
          type: "number",
          description:
            "Total amount of quote_asset you'll pay across this fill (human units). E.g. 1200 USDC for 0.5 ETH at $2400.",
        },
      },
      required: ["rfq_id", "fill_size", "total_payment"],
    },
    requiresSigner: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      // Fetch the parent rfq so we know the pair + decimals.
      const orderbook = await ctx.client.getOrderbook({ status: "open" });
      const parent = orderbook.find((r) => r.id === args.rfq_id);
      if (!parent) {
        throw new Error(
          `place_quote: rfq ${args.rfq_id} not found in open orderbook`,
        );
      }
      // pair shape is "BASE/QUOTE" e.g. "ETH/USDC". source_chain and
      // dest_chain hold the canonical chain ids per asset.
      const [baseSym, quoteSym] = parent.pair.split("/");
      const baseDec = (await ctx.client.listAssets()).find(
        (a) =>
          a.asset_symbol.toUpperCase() === baseSym &&
          normalizeChain(a.chain_id) === parent.source_chain,
      )?.decimals;
      const quoteDec = (await ctx.client.listAssets()).find(
        (a) =>
          a.asset_symbol.toUpperCase() === quoteSym &&
          normalizeChain(a.chain_id) === parent.dest_chain,
      )?.decimals;
      if (baseDec == null || quoteDec == null) {
        throw new Error(
          `place_quote: could not resolve decimals for ${parent.pair}`,
        );
      }
      const impliedRate = args.total_payment / args.fill_size;
      return await signer.placeQuote({
        rfq_id: uuidToBytes16(args.rfq_id),
        quote_id: randomBytes16(),
        rate: toRateBFT(impliedRate, baseDec, quoteDec),
        fill_size: toMicroUnits(args.fill_size, baseDec),
      });
    },
  },
  {
    name: "cancel_rfq",
    description:
      "Sign and submit a CancelRfq — withdraw an open RFQ you previously " +
      "submitted as taker. Locked balance is released back to available.",
    inputSchema: {
      type: "object",
      properties: {
        rfq_id: { type: "string", description: "UUID of the RFQ to cancel" },
        reason: {
          type: "string",
          description: "Optional human-readable reason (logged on chain)",
        },
      },
      required: ["rfq_id"],
    },
    requiresSigner: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      return await signer.cancelRfq({
        rfq_id: uuidToBytes16(args.rfq_id),
        reason: args.reason ?? "agent_cancel",
      });
    },
  },
  {
    name: "accept_quote",
    description:
      "Sign and submit an AcceptQuote — as the taker of the parent RFQ, " +
      "accept a maker's quote and trigger settlement. trade_id is generated " +
      "client-side if not supplied.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "UUID of the quote to accept" },
        trade_id: {
          type: "string",
          description:
            "(Optional) UUID for the resulting trade. Omit to auto-generate",
        },
      },
      required: ["quote_id"],
    },
    requiresSigner: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      return await signer.acceptQuote({
        quote_id: uuidToBytes16(args.quote_id),
        trade_id: args.trade_id ? uuidToBytes16(args.trade_id) : randomBytes16(),
      });
    },
  },
  {
    name: "withdraw_quote",
    description:
      "Sign and submit a WithdrawQuote — as the maker, pull a pending " +
      "quote off the orderbook before it's accepted.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "UUID of the quote to withdraw" },
      },
      required: ["quote_id"],
    },
    requiresSigner: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      return await signer.withdrawQuote({
        quote_id: uuidToBytes16(args.quote_id),
      });
    },
  },
];

export function allTools(hasSigner: boolean): ToolDef[] {
  if (hasSigner) return [...readTools, ...writeTools];
  return readTools;
}

export function findTool(name: string, hasSigner: boolean): ToolDef | undefined {
  return allTools(hasSigner).find((t) => t.name === name);
}

// ─── helpers ──────────────────────────────────────────────────

function requireSigner(ctx: ToolContext): DelegateSigner {
  if (!ctx.signer) {
    throw new Error(
      "This tool requires a configured delegate key. Run `suprafx-mcp init` " +
        "to set one up, or set SUPRAFX_DELEGATE_PRIV_HEX in the environment.",
    );
  }
  return ctx.signer;
}

function assetDecimals(
  assets: AssetInfo[],
  chain: string,
  symbol: string,
): number {
  const normalizedChain = normalizeChain(chain);
  const a = assets.find(
    (r) =>
      r.asset_symbol.toUpperCase() === symbol.toUpperCase() &&
      normalizeChain(r.chain_id) === normalizedChain,
  );
  if (!a) {
    throw new Error(`assetDecimals: ${symbol}@${chain} not in supported assets`);
  }
  return a.decimals;
}

/** Map canonical chain ids to the DB short form used by /api/assets. */
function normalizeChain(chain: string): string {
  if (chain === "eth-mainnet") return "ethereum";
  if (chain === "supra-mainnet") return "supra";
  if (chain === "eth-sepolia") return "sepolia";
  return chain;
}

function uuidToBytes16(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`uuidToBytes16: not a uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes16(): Uint8Array {
  const out = new Uint8Array(16);
  crypto.getRandomValues(out);
  return out;
}
