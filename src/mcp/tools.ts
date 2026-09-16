/**
 * MCP tool definitions + handlers for SupraFX.
 *
 * DESIGN RULE: everything an agent needs in order to trade safely lives
 * in the TOOL CONTRACT — the description it reads before calling, the
 * lifecycle field it gets back, the structured error it gets on failure.
 * Nothing important is left to prose in a doc the agent may never fetch.
 *
 * Tools are split into three classes, selectable at launch
 * (`--tools=read,cancel`):
 *   read   — always available, cannot move money
 *   trade  — opens or fills a position (submit_rfq, place_quote, accept_quote)
 *   cancel — releases a position (cancel_rfq, withdraw_quote)
 *
 * Reference: docs/INTEGRATING-AGENTS.md
 */

import type {
  SupraFxClient,
  AssetInfo,
} from "../client.js";
import { SupraFxError } from "../client.js";
import type { DelegateSigner } from "../signer.js";
import {
  deriveAssetId,
  derivePairIdFromTokens,
  canonicalChain,
} from "../derive-ids.js";
import { toMicroUnits, toRateBFT } from "../asset-registry.js";
import {
  withLifecycle,
  findRfq,
  findQuote,
  sameId,
  type CommitResult,
} from "./lifecycle.js";
import { runPreflight, ORACLE_STALE_MS } from "./preflight.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ToolGroup = "read" | "trade" | "cancel";
export type GateMode = "guarded" | "autonomous";

export interface ToolContext {
  client: SupraFxClient;
  /** Present only when a delegate key is configured. */
  signer: DelegateSigner | null;
  /** The operator's master address, if known. Balances live here. */
  masterAddress?: string | null;
  /** `guarded` requires `acknowledged:true` on every money tool. */
  mode?: GateMode;
  /** Which tool classes this server was launched with. */
  groups?: Set<string>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  /** Requires a configured delegate key (write tool). */
  requiresSigner: boolean;
  /** Tool class, for launch-time selection. Defaults to read. */
  group?: ToolGroup;
  /** Money-moving: gated behind `acknowledged` in guarded mode. */
  dangerous?: boolean;
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

// ─── Shared description fragments ──────────────────────────────
//
// The known failure modes, annotated AT THE TOOL. An agent reads the
// trap here instead of paying for it once and writing it in a notebook
// nobody else can see.

const OK_IS_NOT_COMMITTED =
  "OUTCOME: this tool returns a `lifecycle` field — `applied` (a state " +
  "read confirmed it landed), `rejected` (ingress refused it), or " +
  "`unknown` (ingress accepted it but the confirming read did not see it " +
  "in time). `ok:true` on its own NEVER means committed. Treat `unknown` " +
  "as 'I do not know yet': do NOT retry blindly, read state back.";

const ACK_NOTE =
  "GUARDED MODE: this tool moves real money and requires `acknowledged: true` " +
  "on every call. Launch the server with `--allow-dangerous` (or " +
  "SUPRAFX_ALLOW_DANGEROUS=1) for an autonomous loop that should not stop " +
  "to acknowledge each write.";

const GHOST_LOCK_NOTE =
  "TRAP — ghost locks: collateral can stay locked with no order visibly " +
  "holding it (expiry and other-maker-accepted paths do not always release). " +
  "`list_my_open_orders` shows every order of yours that is still holding " +
  "funds, which is what tells a real lock apart from a ghost one.";

const PRECONDITIONS =
  "Preconditions: delegate configured, active on-chain policy, and " +
  "sufficient available master balance — verify with `get_setup_status` " +
  "and `preflight` first.";

const ACK_PROPERTY = {
  acknowledged: {
    type: "boolean",
    description:
      "Required in guarded mode (the default). Set true to confirm you intend " +
      "this real-money write. Not required when the server runs with " +
      "--allow-dangerous / SUPRAFX_ALLOW_DANGEROUS=1.",
  },
} as const;

// ─── Read tools ────────────────────────────────────────────────

const readTools: ToolDef[] = [
  {
    name: "get_setup_status",
    description:
      "Check whether this MCP server is ready to trade: local config, delegate " +
      "identity, chain connectivity, on-chain policy, sequence, and master balances. " +
      "Read-only and always available; run this before any write tool.",
    inputSchema: { type: "object", properties: {} },
    requiresSigner: false,
    handler: async (_args, ctx) => await getSetupStatus(ctx),
  },
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
      "Return the MASTER's available + locked balances per asset. Delegates " +
      "have no balances of their own. `address` is optional when a master " +
      "address is configured (see `get_master_address`). " +
      "`locked_in_rfq` is trading collateral, `locked_in_orders` is quote-side; " +
      "locked is shared across ALL your open orders, so locked>0 with no " +
      "matching order of yours is the ghost-lock signal — check " +
      "`list_my_open_orders` first. " +
      "This is the TIE-BREAKER read: whenever a write returns `unknown`, come " +
      "here rather than guessing or retrying.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description:
            "0x-prefixed 32-byte MASTER Supra address. Omit to use the configured master.",
        },
      },
    },
    requiresSigner: false,
    group: "read",
    handler: async (args, ctx) => {
      const address = args.address ?? ctx.masterAddress;
      if (!address) {
        throw new ToolError(
          "NO_MASTER_ADDRESS",
          "get_balances needs a master address and none is configured",
          "ask the operator for their master StarKey address and set " +
            "SUPRAFX_MASTER_ADDRESS so it survives a restart",
        );
      }
      return {
        address,
        source: args.address ? "argument" : "configured",
        balances: await ctx.client.getBalances(address),
      };
    },
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
  {
    name: "get_master_address",
    description:
      "Return the operator's MASTER address — the account that holds the " +
      "funds, as opposed to the delegate this server signs as. " +
      "Balance, lock and open-order reads all key on the master, so without " +
      "it verification breaks on any context reset. If it is not configured " +
      "this returns `configured:false` and the exact fix — ask the operator, " +
      "never guess an address.",
    inputSchema: { type: "object", properties: {} },
    requiresSigner: false,
    group: "read",
    handler: async (_args, ctx) => {
      if (!ctx.masterAddress) {
        return {
          master_address: null,
          configured: false,
          how_to_fix:
            "Ask the operator for the StarKey address they connected to " +
            "suprafx.ai with, then export SUPRAFX_MASTER_ADDRESS=0x… or add " +
            '"masterAddress" to ~/.suprafx/config.json and reconnect. ' +
            "`suprafx-mcp init` also asks for it.",
        };
      }
      return { master_address: ctx.masterAddress, configured: true };
    },
  },
  {
    name: "get_deposit_status",
    description:
      "Is a deposit still crediting, credited, or failed? Pass `chain` + " +
      "`tx_hash` for one deposit, or nothing to list every claim of the " +
      "configured master. Returns `state` — `pending` | `credited` | " +
      "`rejected` | `expired` — plus `stale` and the one `next_step`. " +
      "TRAP — fresh wallets: a brand-new wallet's first deposit can take 15+ " +
      "minutes; that reads as `pending` with `stale: true`, which is NOT a " +
      "failure. Wait and re-read; never re-send the deposit, never loop. Only " +
      "`rejected` or `expired` means the credit will not land on its own. " +
      "`found: false` means no claim was recorded for that transaction — the " +
      "deposit can still credit (the bridge does not need the claim); read " +
      "`get_balances` instead.",
    inputSchema: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          description: "Chain the deposit was sent on, e.g. `supra`, `ethereum`. Required with `tx_hash`.",
        },
        tx_hash: {
          type: "string",
          description: "The L1 transaction hash of the deposit. Required with `chain`.",
        },
        address: {
          type: "string",
          description: "MASTER address whose claims to list. Omit to use the configured master.",
        },
        limit: {
          type: "integer",
          description: "List form only. Newest first; the venue caps this at 50.",
        },
      },
    },
    requiresSigner: false,
    group: "read",
    handler: async (args, ctx) => {
      const chain = typeof args.chain === "string" ? args.chain.trim() : "";
      const txHash = typeof args.tx_hash === "string" ? args.tx_hash.trim() : "";
      if (chain && txHash) {
        return await ctx.client.getDepositStatus(chain, txHash);
      }
      if (chain || txHash) {
        throw new ToolError(
          "INVALID_ARGS",
          "get_deposit_status needs BOTH `chain` and `tx_hash` for a single deposit",
          "pass both, or pass neither to list every claim of the configured master",
        );
      }
      const address = (args.address ?? ctx.masterAddress) as string | null;
      if (!address) {
        throw new ToolError(
          "NO_MASTER_ADDRESS",
          "get_deposit_status needs a master address to list claims and none is configured",
          "pass `chain` + `tx_hash`, set SUPRAFX_MASTER_ADDRESS, or pass `address` — see `get_master_address`",
        );
      }
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Number(args.limit) : 20;
      return await ctx.client.listDepositClaims(address, limit);
    },
  },
  {
    name: "list_my_open_orders",
    description:
      "EVERY order of yours that is still holding locked funds — RFQs you " +
      "took, quotes you made — each with the action that releases it. " +
      "This is the answer to 'where did my money go'. Run it before treating " +
      "any lock as a ghost-lock, and after every cancel to confirm release. " +
      "Uses the configured master address unless you pass one.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "MASTER address. Omit to use the configured master.",
        },
      },
    },
    requiresSigner: false,
    group: "read",
    handler: async (args, ctx) => {
      const address = (args.address ?? ctx.masterAddress) as string | null;
      if (!address) {
        throw new ToolError(
          "NO_MASTER_ADDRESS",
          "list_my_open_orders needs a master address and none is configured",
          "set SUPRAFX_MASTER_ADDRESS, or pass `address` — see `get_master_address`",
        );
      }
      const me = address.toLowerCase();
      const rows = [
        ...(await ctx.client.getOrderbook({ status: "open", limit: 200 })),
        ...(await ctx.client.getOrderbook({ status: "expired", limit: 200 })),
      ];
      const myRfqs: unknown[] = [];
      const myQuotes: unknown[] = [];
      for (const r of rows as any[]) {
        const expired = r.expires_at ? Date.parse(r.expires_at) < Date.now() : false;
        if (String(r.taker_address ?? "").toLowerCase() === me) {
          myRfqs.push({
            rfq_id: r.id,
            role: "taker",
            pair: r.pair,
            size: r.size,
            remaining_size: r.remaining_size,
            status: r.status,
            expires_at: r.expires_at,
            expired,
            holds_collateral: true,
            release_with: `cancel_rfq({ rfq_id: "${r.id}", acknowledged: true })`,
          });
        }
        for (const q of (r.quotes ?? []) as any[]) {
          if (String(q.maker_address ?? "").toLowerCase() !== me) continue;
          if (q.status && !["open", "pending", "active"].includes(String(q.status))) continue;
          myQuotes.push({
            quote_id: q.id,
            role: "maker",
            on_rfq: r.id,
            pair: r.pair,
            rate: q.rate,
            status: q.status,
            parent_rfq_status: r.status,
            parent_rfq_expired: expired,
            holds_collateral: true,
            release_with: `withdraw_quote({ quote_id: "${q.id}", acknowledged: true })`,
          });
        }
      }
      const balances = await ctx.client.getBalances(address).catch(() => []);
      const total = myRfqs.length + myQuotes.length;
      return {
        address,
        open_rfqs_as_taker: myRfqs,
        open_quotes_as_maker: myQuotes,
        total_open: total,
        locked_balances: balances
          .filter((b) => (b.locked_in_rfq ?? 0) > 0 || (b.locked_in_orders ?? 0) > 0)
          .map((b) => ({
            asset: b.asset,
            available: b.available,
            locked_in_rfq: b.locked_in_rfq,
            locked_in_orders: b.locked_in_orders,
          })),
        note:
          total === 0
            ? "No open orders of yours. If balances still show locked funds, that " +
              "is a GHOST LOCK — you cannot clear it yourself; report it to the venue."
            : "Each row above holds collateral. Release it with the named call, " +
              "then re-read get_balances to confirm the funds returned to available.",
      };
    },
  },
  {
    name: "get_oracle_price",
    description:
      "Venue fair value for a pair, with the quote's AGE. Quote against this, " +
      `never an external price. A quote older than ${ORACLE_STALE_MS / 1000}s is ` +
      "unusable — `stale:true` means do not quote.",
    inputSchema: {
      type: "object",
      properties: { pair: { type: "string", description: "e.g. 'ETH/USDC'" } },
      required: ["pair"],
    },
    requiresSigner: false,
    group: "read",
    handler: async (args, ctx) => {
      const o = await ctx.client.getOracle(args.pair);
      return {
        ...o,
        stale: o.ageMs == null ? null : o.ageMs > ORACLE_STALE_MS,
        stale_limit_ms: ORACLE_STALE_MS,
      };
    },
  },
  {
    name: "preflight",
    description:
      "Run every check that decides whether it is safe to trade right now, " +
      "each with the ACTION that clears it: venue reachable, venue batch " +
      "actually advancing (not just the L1), venue assets resolving to " +
      "registered ids, oracle freshness, custody, sequence drift, funding, " +
      "and stale own-RFQs still holding collateral. Run on connect and after " +
      "any surprise. `ready_to_trade:false` means stop and read `checks`.",
    inputSchema: {
      type: "object",
      properties: {
        pair: {
          type: "string",
          description: "Pair to check oracle freshness against, e.g. 'ETH/USDC'",
        },
      },
    },
    requiresSigner: false,
    group: "read",
    handler: async (args, ctx) =>
      await runPreflight({
        client: ctx.client,
        signer: ctx.signer,
        masterAddress: ctx.masterAddress ?? null,
        mode: ctx.signer ? (ctx.mode ?? "guarded") : "read_only",
        pair: args.pair,
      }),
  },
];

// ─── Write tools ───────────────────────────────────────────────

const writeTools: ToolDef[] = [
  {
    name: "submit_rfq",
    description:
      "Sign and submit a SubmitRfq — become the taker on a new RFQ. " +
      "LOCKS `size` of `sell_token` from the master's available balance " +
      "until it matches, expires (30 min default), or you cancel it. " +
      `${OK_IS_NOT_COMMITTED} ` +
      "Confirmed by reading the RFQ back off the orderbook. " +
      "TRAP — an RFQ with an already-past expiry, or min_fill_size > size, " +
      "can commit and then sit dead while holding your collateral; both are " +
      "refused here before they can lock anything. " +
      `${GHOST_LOCK_NOTE} ${ACK_NOTE} ${PRECONDITIONS}`,
    inputSchema: {
      type: "object",
      properties: {
        sell_chain: {
          type: "string",
          description:
            "Chain of the asset you're selling. EITHER spelling works: " +
            "'ethereum' (as list_assets returns it) or 'eth-mainnet' (canonical).",
        },
        sell_token: {
          type: "string",
          description: "Symbol of the asset you're selling (e.g. 'ETH', 'USDC')",
        },
        buy_chain: {
          type: "string",
          description: "Chain of the asset you want. Either spelling works.",
        },
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
        ...ACK_PROPERTY,
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
    group: "trade",
    dangerous: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      requireAck(args, ctx, "submit_rfq");
      const expiresInMinutes = assertRfqIsFillable(args);
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
      const clockOffsetMs = await ctx.client.getVenueClockOffsetMs();
      warnIfClockSkewed(clockOffsetMs);
      const expiresAtMs = BigInt(
        Date.now() + clockOffsetMs + expiresInMinutes * 60 * 1000,
      );
      const allowPartial = !!args.allow_partial_fills;
      const rfqIdBytes = randomBytes16();
      const rfqUuid = bytes16ToUuid(rfqIdBytes);
      const res = await signer.submitRfq({
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
        rfq_id: rfqIdBytes,
        settlement_mode:
          args.settlement_mode === "OnChain" ? "OnChain" : "Platform",
      });
      const commit = await withLifecycle(res, {
        verifiedBy: `get_orderbook for rfq_id ${rfqUuid}`,
        tieBreaker: `get_balances, and list_my_open_orders for rfq_id ${rfqUuid}`,
        check: async () => (await findRfq(ctx.client, rfqUuid)) != null,
      });
      return { rfq_id: rfqUuid, ...commit };
    },
  },
  {
    name: "place_quote",
    description:
      "Sign and submit a PlaceQuote on an open RFQ — become the maker. " +
      "LOCKS `total_payment` of the RFQ's quote_asset from your master balance " +
      "until the taker accepts, the RFQ dies, or you withdraw_quote. " +
      `${OK_IS_NOT_COMMITTED} ` +
      "Confirmed by reading the quote back off the parent RFQ. " +
      "TRAP — a quote's lock is NOT shown anywhere on the taker-side " +
      "orderbook; use `list_my_open_orders` to see it. " +
      `${ACK_NOTE} ${PRECONDITIONS}`,
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
    group: "trade",
    dangerous: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      requireAck(args, ctx, "place_quote");
      if (!(args.fill_size > 0) || !(args.total_payment > 0)) {
        throw new ToolError(
          "INVALID_QUOTE",
          "fill_size and total_payment must both be > 0",
          "pass positive values for both",
        );
      }
      // Fetch the parent rfq so we know the pair + decimals.
      const orderbook = await ctx.client.getOrderbook({ status: "open", limit: 200 });
      const parent = orderbook.find((r) => sameId(r.id, args.rfq_id));
      if (!parent) {
        throw new ToolError(
          "RFQ_NOT_OPEN",
          `rfq ${args.rfq_id} is not in the open orderbook`,
          "it may have matched, expired or been cancelled — re-read `get_orderbook`",
        );
      }
      // pair is "BASE/QUOTE" e.g. "ETH/USDC". RFQ rows carry CANONICAL
      // chain ids ("eth-mainnet") while /api/assets carries SHORT ones
      // ("ethereum") — comparing them raw never matched, so this threw on
      // every call. canonicalChain folds both sides.
      const [baseSym, quoteSym] = parent.pair.split("/");
      const assets = await ctx.client.listAssets();
      const findDec = (sym: string, chain: string) =>
        assets.find(
          (a) =>
            a.asset_symbol.toUpperCase() === sym.toUpperCase() &&
            canonicalChain(a.chain_id) === canonicalChain(chain),
        )?.decimals;
      const baseDec = findDec(baseSym, parent.source_chain);
      const quoteDec = findDec(quoteSym, parent.dest_chain);
      if (baseDec == null || quoteDec == null) {
        throw new ToolError(
          "UNRESOLVED_DECIMALS",
          `could not resolve decimals for ${parent.pair} (${parent.source_chain} / ${parent.dest_chain})`,
          "the venue lists an asset this SDK does not know — `npm update -g suprafx-agent-sdk` and report",
        );
      }
      const quoteIdBytes = randomBytes16();
      const quoteUuid = bytes16ToUuid(quoteIdBytes);
      const impliedRate = args.total_payment / args.fill_size;
      const res = await signer.placeQuote({
        rfq_id: uuidToBytes16(parent.id),
        quote_id: quoteIdBytes,
        rate: toRateBFT(impliedRate, baseDec, quoteDec),
        fill_size: toMicroUnits(args.fill_size, baseDec),
      });
      const commit = await withLifecycle(res, {
        verifiedBy: `get_orderbook — quote ${quoteUuid} on rfq ${parent.id}`,
        tieBreaker: "get_balances and list_my_open_orders",
        check: async () => (await findQuote(ctx.client, quoteUuid)) != null,
      });
      return { quote_id: quoteUuid, rfq_id: parent.id, implied_rate: impliedRate, ...commit };
    },
  },
  {
    name: "cancel_rfq",
    description:
      "Sign and submit a CancelRfq — withdraw an open RFQ you took, releasing " +
      "its locked collateral back to available. " +
      `${OK_IS_NOT_COMMITTED} ` +
      "Confirmed by reading the RFQ's status off the orderbook. " +
      "ALWAYS re-read `get_balances` after this: confirming the RFQ closed is " +
      "NOT the same as confirming the funds came back. " +
      "NOTE — consumes no sequence number, so it cannot desync your counter. " +
      `${ACK_NOTE} ${PRECONDITIONS}`,
    inputSchema: {
      type: "object",
      properties: {
        rfq_id: { type: "string", description: "UUID of the RFQ to cancel" },
        reason: {
          type: "string",
          description: "Optional human-readable reason (logged on chain)",
        },
        ...ACK_PROPERTY,
      },
      required: ["rfq_id"],
    },
    requiresSigner: true,
    group: "cancel",
    dangerous: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      requireAck(args, ctx, "cancel_rfq");
      const res = await signer.cancelRfq({
        rfq_id: uuidToBytes16(args.rfq_id),
        // The chain mempool TxId hashes the full event. An identical retry is
        // deduped forever if the first submission was silently dropped, so a
        // generated reason must be unique on every call.
        reason: args.reason ?? `agent_cancel-${shortUniqueSuffix()}`,
      });
      const commit = await withLifecycle(res, {
        verifiedBy: `get_orderbook — status of rfq ${args.rfq_id}`,
        tieBreaker: "get_balances — confirm the collateral returned to available",
        check: async () => {
          const found = await findRfq(ctx.client, args.rfq_id);
          if (!found) return false;
          return String(found.status ?? "").toLowerCase() !== "open";
        },
      });
      return {
        rfq_id: args.rfq_id,
        ...commit,
        next_step:
          "Re-read get_balances and confirm the locked amount returned to " +
          "available. Locks do not always release on their own.",
      };
    },
  },
  {
    name: "accept_quote",
    description:
      "Sign and submit an AcceptQuote — as the taker of the parent RFQ, accept " +
      "a maker's quote and trigger settlement. THIS SPENDS: it is the point of " +
      "no return for the trade. " +
      `${OK_IS_NOT_COMMITTED} ` +
      "Confirmed by reading the quote's status back off the orderbook. " +
      "trade_id is generated client-side if not supplied. " +
      `${ACK_NOTE} ${PRECONDITIONS}`,
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "UUID of the quote to accept" },
        trade_id: {
          type: "string",
          description:
            "(Optional) UUID for the resulting trade. Omit to auto-generate",
        },
        ...ACK_PROPERTY,
      },
      required: ["quote_id"],
    },
    requiresSigner: true,
    group: "trade",
    dangerous: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      requireAck(args, ctx, "accept_quote");
      const res = await signer.acceptQuote({
        quote_id: uuidToBytes16(args.quote_id),
        trade_id: args.trade_id ? uuidToBytes16(args.trade_id) : randomBytes16(),
      });
      const commit = await withLifecycle(res, {
        verifiedBy: `get_orderbook — status of quote ${args.quote_id}`,
        tieBreaker: "get_balances (the trade should have moved both assets)",
        check: async () => {
          const found = await findQuote(ctx.client, args.quote_id);
          if (!found) return false;
          const st = String(found.quote.status ?? "").toLowerCase();
          return st === "accepted" || found.rfqStatus === "matched";
        },
      });
      return { quote_id: args.quote_id, ...commit };
    },
  },
  {
    name: "withdraw_quote",
    description:
      "Sign and submit a WithdrawQuote — as the maker, pull a pending quote off " +
      "the orderbook before it is accepted, releasing its lock. " +
      "THIS IS NOT A FUND WITHDRAWAL: it does not move money off SupraFX. " +
      "Getting funds OUT is a master-signed dApp action, and this delegate key " +
      "cannot do it. " +
      `${OK_IS_NOT_COMMITTED} ` +
      "ALWAYS re-read `get_balances` after this. " +
      "NOTE — consumes no sequence number. " +
      `${ACK_NOTE} ${PRECONDITIONS}`,
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "UUID of the quote to withdraw" },
        ...ACK_PROPERTY,
      },
      required: ["quote_id"],
    },
    requiresSigner: true,
    group: "cancel",
    dangerous: true,
    handler: async (args, ctx) => {
      const signer = requireSigner(ctx);
      requireAck(args, ctx, "withdraw_quote");
      const res = await signer.withdrawQuote({
        quote_id: uuidToBytes16(args.quote_id),
      });
      const commit = await withLifecycle(res, {
        verifiedBy: `get_orderbook — status of quote ${args.quote_id}`,
        tieBreaker: "get_balances — confirm the lock returned to available",
        check: async () => {
          const found = await findQuote(ctx.client, args.quote_id);
          if (!found) return true; // gone from the book = pulled
          const st = String(found.quote.status ?? "").toLowerCase();
          return st !== "open" && st !== "pending" && st !== "active";
        },
      });
      return {
        quote_id: args.quote_id,
        ...commit,
        next_step: "Re-read get_balances and confirm the lock returned to available.",
      };
    },
  },
];

/** `read` is never withheld; omitting `groups` exposes every class. */
function inGroups(t: ToolDef, groups?: Set<string>): boolean {
  if (!groups) return true;
  return groups.has(t.group ?? "read");
}

export function allTools(hasSigner: boolean, groups?: Set<string>): ToolDef[] {
  const reads = readTools.filter((t) => inGroups(t, groups));
  if (hasSigner) return [...reads, ...writeTools.filter((t) => inGroups(t, groups))];
  return reads;
}

export function findTool(
  name: string,
  hasSigner: boolean,
  groups?: Set<string>,
): ToolDef | undefined {
  // A client may call a previously-discovered write tool after its key is
  // removed. Keep lookup available so it receives NO_DELEGATE_CONFIGURED
  // rather than a confusing "unknown tool".
  //
  // A tool excluded by `--tools=` is a DIFFERENT case: the operator chose
  // not to expose it, so it must not be callable at all.
  return [...readTools, ...writeTools]
    .filter((t) => inGroups(t, groups))
    .find((t) => t.name === name);
}

// ─── helpers ──────────────────────────────────────────────────

function requireSigner(ctx: ToolContext): DelegateSigner {
  if (!ctx.signer) {
    throw new ToolError(
      "NO_DELEGATE_CONFIGURED",
      "run `suprafx-mcp init` or set SUPRAFX_DELEGATE_PRIV_HEX, then retry",
      "suprafx-mcp init",
    );
  }
  return ctx.signer;
}

/**
 * Decimals for `(chain, symbol)`, comparing chain ids in CANONICAL form.
 *
 * This used to fold both sides to the short DB form. That worked for
 * `/api/assets` (which returns `"ethereum"`) but NOT for RFQ rows (which
 * return `"eth-mainnet"`), so `place_quote` compared `"ethereum"` against
 * `"eth-mainnet"`, never matched, and threw on every single call.
 * `canonicalChain` folds both directions, so either spelling works.
 */
function assetDecimals(
  assets: AssetInfo[],
  chain: string,
  symbol: string,
): number {
  const want = canonicalChain(chain);
  const a = assets.find(
    (r) =>
      r.asset_symbol.toUpperCase() === symbol.toUpperCase() &&
      canonicalChain(r.chain_id) === want,
  );
  if (!a) {
    throw new ToolError(
      "UNSUPPORTED_ASSET",
      `${symbol}@${chain} is not a supported asset`,
      "call `list_assets` and use a chain_id and asset_symbol from that list",
    );
  }
  return a.decimals;
}

function uuidToBytes16(uuid: string): Uint8Array {
  // Lower-cased: the venue has returned ids in mixed casing, and an
  // upper-case id must encode to the same 16 bytes.
  const hex = uuid.replace(/-/g, "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new ToolError("BAD_UUID", `not a uuid: ${uuid}`, "pass the id exactly as the orderbook returned it");
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes16(): Uint8Array {
  const out = new Uint8Array(16);
  crypto.getRandomValues(out);
  return out;
}

/** Render 16 bytes as a dashed UUID so the id we return matches the one
 *  the orderbook will show — the only way apply-verification can compare. */
function bytes16ToUuid(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The guarded gate. Key-presence alone is not a stop: once a key loads,
 * `accept_quote` was as ungated as `get_orderbook`. In guarded mode every
 * money tool needs an explicit per-call `acknowledged:true`; an autonomous
 * loop opts out once, at launch, in the open.
 */
function requireAck(args: any, ctx: ToolContext, toolName: string): void {
  if ((ctx.mode ?? "guarded") === "autonomous") return;
  if (args?.acknowledged === true) return;
  throw new ToolError(
    "NEEDS_ACKNOWLEDGEMENT",
    `${toolName} moves real money and this server is in GUARDED mode`,
    "re-send the identical call with `acknowledged: true`; for an autonomous " +
      "loop the OPERATOR relaunches with --allow-dangerous — do not work around this",
  );
}

/** Reject an RFQ that could never fill but would still lock collateral. */
function assertRfqIsFillable(args: any): number {
  const expiresInMinutes = args.expires_in_minutes ?? 30;
  if (!(expiresInMinutes > 0)) {
    throw new ToolError(
      "RFQ_DEAD_ON_ARRIVAL",
      `expires_in_minutes must be > 0 (got ${expiresInMinutes})`,
      "an already-expired RFQ can commit and lock collateral nobody can fill — pass a positive expiry",
    );
  }
  if (!(args.size > 0)) {
    throw new ToolError(
      "RFQ_DEAD_ON_ARRIVAL",
      `size must be > 0 (got ${args.size})`,
      "pass a positive size",
    );
  }
  if (args.allow_partial_fills && (args.min_fill_size ?? 0) > args.size) {
    throw new ToolError(
      "RFQ_DEAD_ON_ARRIVAL",
      `min_fill_size (${args.min_fill_size}) exceeds size (${args.size})`,
      "no fill could satisfy it, but the RFQ would still lock funds — lower min_fill_size",
    );
  }
  return expiresInMinutes;
}

let uniqueReasonCounter = 0;

function shortUniqueSuffix(): string {
  uniqueReasonCounter = (uniqueReasonCounter + 1) & 0xfffff;
  return `${Date.now().toString(36)}-${uniqueReasonCounter.toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly remedy: string,
  ) {
    super(detail);
  }
}

type CheckState = "ok" | "warn" | "fail" | "unknown";
interface SetupCheck {
  status: CheckState;
  detail: string;
  remedy: string;
}

const CLOCK_SKEW_WARNING_MS = 60_000;

function clockSkewSeconds(offsetMs: number): number {
  return Math.sign(offsetMs) * Math.ceil(Math.abs(offsetMs) / 1000);
}

function warnIfClockSkewed(offsetMs: number): void {
  if (Math.abs(offsetMs) > CLOCK_SKEW_WARNING_MS) {
    console.error(
      `local clock skewed by ${clockSkewSeconds(offsetMs)}s vs venue; using server-aligned expiry`,
    );
  }
}

async function getSetupStatus(ctx: ToolContext): Promise<Record<string, SetupCheck>> {
  const configPath = join(homedir(), ".suprafx", "config.json");
  const configPresent = existsSync(configPath);
  const report: Record<string, SetupCheck> = {
    config_file: configPresent
      ? { status: "ok", detail: `config file present at ${configPath}`, remedy: "suprafx-mcp" }
      : {
          status: ctx.signer ? "warn" : "fail",
          detail: ctx.signer
            ? "config file absent; delegate key was loaded from the environment"
            : `config file absent at ${configPath}`,
          remedy: "suprafx-mcp init",
        },
    delegate_key: ctx.signer
      ? { status: "ok", detail: `delegate address ${ctx.signer.addressHex}`, remedy: "suprafx-mcp" }
      : {
          status: "fail",
          detail: "no delegate key is loaded",
          remedy: "suprafx-mcp init",
        },
    chain_reachable: {
      status: "unknown",
      detail: "chain connectivity not checked yet",
      remedy: "suprafx-mcp",
    },
    clock_skew: {
      status: "unknown",
      detail: "venue clock offset not checked yet",
      remedy: "sync your system clock (NTP)",
    },
    delegate_policy: {
      status: "unknown",
      detail: "requires a loaded delegate address",
      remedy: "suprafx-mcp init",
    },
    sequence_number: {
      status: "unknown",
      detail: "requires a loaded delegate address",
      remedy: "suprafx-mcp init",
    },
    master_balances: {
      status: "unknown",
      detail: "requires a master address returned by the delegate-policy endpoint",
      remedy: "suprafx-mcp init",
    },
  };

  try {
    const info = await ctx.client.getChainInfo();
    report.chain_reachable = {
      status: "ok",
      detail: `chain reachable (${info.chainId})`,
      remedy: "suprafx-mcp",
    };
  } catch (e) {
    report.chain_reachable = {
      status: "fail",
      detail: errorMessage(e),
      remedy: "curl -f https://suprafx.ai/api/council/chain-info",
    };
  }

  const clockOffsetMs = await ctx.client.getVenueClockOffsetMs();
  const skewSeconds = clockSkewSeconds(clockOffsetMs);
  report.clock_skew = Math.abs(clockOffsetMs) > CLOCK_SKEW_WARNING_MS
    ? {
        status: "warn",
        detail: `local clock is skewed by ${skewSeconds}s versus the venue`,
        remedy: "sync your system clock (NTP)",
      }
    : {
        status: "ok",
        detail: `local clock skew is ${skewSeconds}s versus the venue`,
        remedy: "sync your system clock (NTP)",
      };

  if (!ctx.signer) return report;
  const delegate = ctx.signer.addressHex;
  try {
    const next = await ctx.client.getSequenceNumber(delegate);
    report.sequence_number = {
      status: "ok",
      detail: `next sequence number ${next}`,
      remedy: `curl -f 'https://suprafx.ai/api/council/sequence-number?address=${delegate}'`,
    };
  } catch (e) {
    report.sequence_number = {
      status: "unknown",
      detail: errorMessage(e),
      remedy: `curl -f 'https://suprafx.ai/api/council/sequence-number?address=${delegate}'`,
    };
  }

  try {
    const policy = await ctx.client.getDelegatePolicy(delegate);
    if (!policy) {
      report.delegate_policy = {
        status: "fail",
        detail: "no on-chain delegate policy found",
        remedy: "open https://suprafx.ai/profile and create or reactivate this delegate",
      };
      return report;
    }
    report.delegate_policy = policy.active === false
      ? {
          status: "fail",
          detail: "delegate policy exists but is inactive",
          remedy: "open https://suprafx.ai/profile and create or reactivate this delegate",
        }
      : {
          status: policy.active === true ? "ok" : "warn",
          detail: policy.active === true
            ? "active on-chain delegate policy found"
            : "delegate policy found, but the response did not state whether it is active",
          remedy: `curl -f 'https://suprafx.ai/api/delegate-policy?delegate=${delegate}'`,
        };
    const master = typeof policy.master_address === "string"
      ? policy.master_address
      : typeof policy.master === "string" ? policy.master : null;
    if (!master) {
      report.master_balances = {
        status: "unknown",
        detail: "delegate policy response did not expose a master address",
        remedy: `curl -f 'https://suprafx.ai/api/delegate-policy?delegate=${delegate}'`,
      };
      return report;
    }
    try {
      const balances = await ctx.client.getBalances(master);
      report.master_balances = {
        status: balances.length > 0 ? "ok" : "warn",
        detail: balances.length > 0
          ? `master ${master} has ${balances.length} balance row(s): ${JSON.stringify(balances)}`
          : `master ${master} has no balance rows`,
        remedy: `curl -f 'https://suprafx.ai/api/platform/balances?address=${master}'`,
      };
    } catch (e) {
      report.master_balances = {
        status: "unknown",
        detail: errorMessage(e),
        remedy: `curl -f 'https://suprafx.ai/api/platform/balances?address=${master}'`,
      };
    }
  } catch (e) {
    report.delegate_policy = {
      status: "unknown",
      detail: errorMessage(e),
      remedy: `curl -f 'https://suprafx.ai/api/delegate-policy?delegate=${delegate}'`,
    };
  }
  return report;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
