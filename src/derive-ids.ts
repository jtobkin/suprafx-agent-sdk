/**
 * Asset + pair ID derivation for council `SubmitRfq` events.
 *
 * The chain treats asset_id and pair_id as opaque 32-byte values —
 * it doesn't validate the derivation, just routes events by ID. So
 * the only invariant is **consistency across calls**: SupraFX must
 * derive the same ID for the same (chain, token) tuple every time,
 * across all users + sessions, otherwise orderbook state diverges
 * (two users referring to "ETH on Sepolia" via different IDs would
 * fail to match).
 *
 * ## Convention (V2 — chain-canonical)
 *
 * `asset_id = BLAKE3-keyed(key=BLAKE3("SUPRAFX-ASSET-V1"),
 *                          message=[chain_id_len_u8, ...chain_id_utf8,
 *                                   ...token_address_bytes])`
 * `pair_id  = BLAKE3("suprafx-pair-v1\n" + base_asset_hex
 *                                        + "\n" + quote_asset_hex)`
 *
 * V2 mirrors `council_bridge::identity::asset_id_from_chain_and_token`
 * byte-for-byte. Required because the bridge credits L1 deposits
 * under THIS asset_id; if the dApp's RFQ uses a different derivation
 * (V1), the chain says "no balance" and the validator gate rejects
 * the trade. The migration is one-time — open RFQs from V1 days
 * remain in the legacy table but are unmatchable on the new orderbook.
 *
 * ## Token address registry
 *
 * The chain stores asset_id under `(canonicalChainId, tokenBytes)`,
 * where tokenBytes is:
 *   - `[0u8; 20]` for the native EVM coin (`EVM_NATIVE_TOKEN_BYTES`)
 *   - the 20-byte ERC-20 contract address otherwise
 *   - `[0u8; 32]` for native Supra
 * The dApp UI thinks in `(uiChain, symbol)` strings. The registry
 * below bridges the two; new tokens MUST be added here AND in the
 * validator's `bridge.eth_chains[*].asset_decimals` operator config
 * before they can be deposited.
 */

import { blake3 } from "@noble/hashes/blake3.js";

const ASSET_DST = "SUPRAFX-ASSET-V1";
const PAIR_DST = "suprafx-pair-v1";

const ASSET_DST_KEY: Uint8Array = blake3(new TextEncoder().encode(ASSET_DST));

/**
 * Token-address registry — UI `(chain, symbol)` → canonical
 * `(chainId, tokenBytes)` used by the chain. `chainId` is what the
 * bridge observer puts in the deposit's `source_chain` field; the
 * symbol-to-address mapping must match the validator's
 * `asset_decimals` operator config exactly.
 *
 * For untradable / test assets not in this registry, callers fall
 * through to V1 derivation as a soft-compat path (kept so explorer
 * UIs and unit tests don't break).
 */
const EVM_NATIVE = new Uint8Array(20); // all zeros
const EVM_NATIVE_HEX = "00".repeat(20);
const SUPRA_NATIVE = new Uint8Array(32); // all zeros

interface TokenSpec {
  chainId: string;
  tokenBytes: Uint8Array;
}

function supraAddr32(hex: string): Uint8Array {
  const s = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (s.length !== 64) throw new Error(`supraAddr32: ${hex} not 32 bytes`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const TOKEN_REGISTRY: Map<string, TokenSpec> = new Map([
  // ────────────────────────────────────────────────────────────────────
  // Sepolia / Supra-testnet (kept for dev + sepolia testing)
  // ────────────────────────────────────────────────────────────────────
  ["sepolia/ETH", { chainId: "eth-sepolia", tokenBytes: EVM_NATIVE }],
  ["eth-sepolia/ETH", { chainId: "eth-sepolia", tokenBytes: EVM_NATIVE }],
  // Sepolia USDC — must match validator config (operator-enabled token).
  // Address per deploy/dev/node-1/node.json asset_decimals.
  [
    "sepolia/USDC",
    {
      chainId: "eth-sepolia",
      tokenBytes: hexAddrToBytes("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"),
    },
  ],
  [
    "eth-sepolia/USDC",
    {
      chainId: "eth-sepolia",
      tokenBytes: hexAddrToBytes("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"),
    },
  ],
  ["supra/SUPRA", { chainId: "supra-testnet", tokenBytes: SUPRA_NATIVE }],
  ["supra-testnet/SUPRA", { chainId: "supra-testnet", tokenBytes: SUPRA_NATIVE }],

  // ────────────────────────────────────────────────────────────────────
  // Mainnet beta — 11 assets baked into the suprafx-mainnet-1 genesis
  // (2026-05-27 ceremony, audit.json). Addresses verified live against
  // Etherscan + on-chain Supra RPC. Each entry registered under TWO
  // UI keys: short ("mainnet/X", "supra/X") + canonical chain id
  // ("eth-mainnet/X", "supra-mainnet/X").
  // ────────────────────────────────────────────────────────────────────

  // ETH (native)
  ["mainnet/ETH", { chainId: "eth-mainnet", tokenBytes: EVM_NATIVE }],
  ["eth-mainnet/ETH", { chainId: "eth-mainnet", tokenBytes: EVM_NATIVE }],

  // WBTC — 8 decimals (matches BTC)
  [
    "mainnet/WBTC",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"),
    },
  ],
  [
    "eth-mainnet/WBTC",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"),
    },
  ],

  // USDC — 6 decimals (Circle)
  [
    "mainnet/USDC",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    },
  ],
  [
    "eth-mainnet/USDC",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    },
  ],

  // USDT — 6 decimals (Tether)
  [
    "mainnet/USDT",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0xdac17f958d2ee523a2206206994597c13d831ec7"),
    },
  ],
  [
    "eth-mainnet/USDT",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0xdac17f958d2ee523a2206206994597c13d831ec7"),
    },
  ],

  // AAVE — 18 decimals
  [
    "mainnet/AAVE",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9"),
    },
  ],
  [
    "eth-mainnet/AAVE",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9"),
    },
  ],

  // LINK — 18 decimals (Chainlink)
  [
    "mainnet/LINK",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0x514910771af9ca656af840dff83e8264ecf986ca"),
    },
  ],
  [
    "eth-mainnet/LINK",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0x514910771af9ca656af840dff83e8264ecf986ca"),
    },
  ],

  // UNI — 18 decimals (Uniswap)
  [
    "mainnet/UNI",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"),
    },
  ],
  [
    "eth-mainnet/UNI",
    {
      chainId: "eth-mainnet",
      tokenBytes: hexAddrToBytes("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"),
    },
  ],

  // SUPRA — native Supra mainnet (32-byte zero address)
  ["supra-mainnet/SUPRA", { chainId: "supra-mainnet", tokenBytes: SUPRA_NATIVE }],

  // iAssets — Supra PoEL Fungible Asset Metadata object addresses,
  // pulled directly from Supra mainnet on 2026-05-27 (all 8 decimals,
  // by Supra's iAsset framework convention). Genesis pre-commits these
  // slots; deposit support ships in v1.1 (committee_vault FA refactor).
  //
  // Registry keys are UPPERCASE per `deriveAssetId`'s `.toUpperCase()`
  // normalization — UI labels can still render "iUSDC" / "iWBTC" /
  // "iUSDT"; the lookup just goes through the uppercase form.
  [
    "supra-mainnet/IUSDC",
    {
      chainId: "supra-mainnet",
      tokenBytes: supraAddr32(
        "0x90a8e901e02ac1539af4a865bbe4a6b96edc27375488803cfbbd6875ec57b281",
      ),
    },
  ],
  [
    "supra-mainnet/IUSDT",
    {
      chainId: "supra-mainnet",
      tokenBytes: supraAddr32(
        "0xceff14089bde0d4f512dcd3b6f3df6794346c58115b8d97e043f92ff08cd1fca",
      ),
    },
  ],
  [
    "supra-mainnet/IWBTC",
    {
      chainId: "supra-mainnet",
      tokenBytes: supraAddr32(
        "0xbc8d1fb1ea5f22dd931935cbdcb128bbb205e567a6b5225fe6994f8bafc8702a",
      ),
    },
  ],
]);

function hexAddrToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (s.length !== 40) throw new Error(`hexAddrToBytes: ${hex} not 20 bytes`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Chain-canonical asset_id. Mirrors
 * `council_bridge::identity::asset_id_from_chain_and_token`.
 *
 *   asset_id = blake3-keyed(
 *     key = blake3("SUPRAFX-ASSET-V1"),
 *     msg = [chain_id.len() as u8, ...chain_id_utf8, ...token_bytes],
 *   )
 *
 * `chainId` is the canonical bridge chain identifier (`eth-sepolia`,
 * `supra-testnet`, etc). `tokenBytes` is the L1 token address — 20
 * bytes for EVM (zero for native), 32 bytes for Supra (zero for native).
 */
export function assetIdFromChainAndToken(
  chainId: string,
  tokenBytes: Uint8Array,
): Uint8Array {
  if (chainId.length > 0xff) {
    throw new Error(
      `assetIdFromChainAndToken: chainId too long (${chainId.length} > 255)`,
    );
  }
  const chainBytes = new TextEncoder().encode(chainId);
  const msg = new Uint8Array(1 + chainBytes.length + tokenBytes.length);
  msg[0] = chainBytes.length;
  msg.set(chainBytes, 1);
  msg.set(tokenBytes, 1 + chainBytes.length);
  return blake3(msg, { key: ASSET_DST_KEY });
}

/**
 * Derive a 32-byte AssetId from a UI-friendly `(chain, symbol)` tuple.
 *
 * Resolves through TOKEN_REGISTRY to the canonical
 * `(chainId, tokenBytes)` then hashes per
 * [`assetIdFromChainAndToken`]. For tokens not in the registry
 * (test/explorer use cases), falls back to the V1 hash so
 * downstream code that doesn't actually trade these IDs keeps
 * working — but the return value is NOT what the chain expects
 * for the unregistered token, so RFQ submission against it WILL
 * fail at the validator gate.
 */
export function deriveAssetId(chain: string, symbol: string): Uint8Array {
  const key = `${chain.toLowerCase()}/${symbol.toUpperCase()}`;
  const spec = TOKEN_REGISTRY.get(key);
  if (spec) {
    return assetIdFromChainAndToken(spec.chainId, spec.tokenBytes);
  }
  // Soft-compat: legacy V1 hash for unregistered assets.
  const enc = new TextEncoder();
  const msg = enc.encode(`suprafx-asset-v1\n${chain}\n${symbol}`);
  return blake3(msg);
}

/**
 * Like `deriveAssetId`, but returns `null` for a `(chain, symbol)`
 * NOT in `TOKEN_REGISTRY` — instead of silently falling through to
 * the V1 hash.
 *
 * Callers that need the REAL chain-canonical AssetId — delegate
 * `asset_caps` (Option B), deposit crediting — MUST use this and
 * treat `null` as "not a tradeable asset yet". Embedding a V1 hash in
 * a delegate's cap map authorizes a phantom id, and the moment the
 * asset is later registered every old session's map goes stale.
 */
export function registeredAssetId(
  chain: string,
  symbol: string,
): Uint8Array | null {
  const key = `${chain.toLowerCase()}/${symbol.toUpperCase()}`;
  const spec = TOKEN_REGISTRY.get(key);
  return spec ? assetIdFromChainAndToken(spec.chainId, spec.tokenBytes) : null;
}

/**
 * Derive a 32-byte PairId from base + quote AssetId values.
 *
 * Order matters: `(ETH, USDC)` produces a different pair than
 * `(USDC, ETH)`. SubmitRfq's `base_asset` is what the user gives
 * up; `quote_asset` is what they receive.
 */
export function derivePairId(
  baseAssetId: Uint8Array,
  quoteAssetId: Uint8Array,
): Uint8Array {
  if (baseAssetId.length !== 32 || quoteAssetId.length !== 32) {
    throw new Error(
      `derivePairId: asset IDs must be 32 bytes (got ${baseAssetId.length}, ${quoteAssetId.length})`,
    );
  }
  const enc = new TextEncoder();
  const baseHex = bytesToHex(baseAssetId);
  const quoteHex = bytesToHex(quoteAssetId);
  const msg = enc.encode(`${PAIR_DST}\n${baseHex}\n${quoteHex}`);
  return blake3(msg);
}

/**
 * Convenience: one-call `(chain, symbol)` × 2 → 32-byte PairId.
 */
export function derivePairIdFromTokens(
  baseChain: string,
  baseSymbol: string,
  quoteChain: string,
  quoteSymbol: string,
): Uint8Array {
  return derivePairId(
    deriveAssetId(baseChain, baseSymbol),
    deriveAssetId(quoteChain, quoteSymbol),
  );
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
