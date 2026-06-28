/**
 * 04 — Auto-accept + partial-fills taker (a resting limit order).
 *
 * Submits ONE large RFQ that combines the two taker primitives:
 *   - auto_accept = true        → every qualifying maker quote settles
 *                                 instantly on chain, no AcceptQuote,
 *                                 taker can be completely offline; and
 *   - allow_partial_fills = true → the RFQ fills in slices and stays
 *                                 open (with a shrinking remaining size)
 *                                 until it is fully filled.
 *
 * Together they are a resting limit order: the RFQ absorbs many small
 * maker quotes, each guaranteed at or above your `TARGET_RATE` floor,
 * incrementally, until the whole `SIZE` is filled — completely
 * hands-off. This agent submits it, watches the fills roll in, and
 * cancels any unfilled remainder at the deadline (releasing the
 * earmark). Demonstrates submit_rfq (auto-accept + partial) and
 * cancel_rfq.
 *
 * Run with:
 *   SUPRAFX_DELEGATE_PRIV_HEX=... \
 *   PAIR=ETH/USDC \
 *   SELL_CHAIN=eth-mainnet SELL_TOKEN=ETH \
 *   BUY_CHAIN=eth-mainnet  BUY_TOKEN=USDC \
 *   SIZE=1.0 TARGET_RATE=2400 MIN_FILL=0.1 DEADLINE_MIN=10 \
 *   npx tsx cookbook/04-auto-accept-partial-taker.ts
 */

import EventSource from "eventsource";
import {
  SupraFxClient,
  DelegateSigner,
  deriveAssetId,
  derivePairIdFromTokens,
  toMicroUnits,
  toRateBFT,
} from "../src/index.js";

const PAIR = process.env.PAIR ?? "ETH/USDC";
const SELL_CHAIN = process.env.SELL_CHAIN ?? "eth-mainnet";
const SELL_TOKEN = process.env.SELL_TOKEN ?? "ETH";
const BUY_CHAIN = process.env.BUY_CHAIN ?? "eth-mainnet";
const BUY_TOKEN = process.env.BUY_TOKEN ?? "USDC";
const SIZE = Number(process.env.SIZE ?? 1.0);
// Price floor: the MINIMUM quote-per-base you'll accept. The chain never
// fills (or lets anyone accept) a quote below this — even auto-fire.
const TARGET_RATE = Number(process.env.TARGET_RATE ?? 2400);
// Smallest slice you'll take. Your dust guard, enforced on the actual fill.
const MIN_FILL = Number(process.env.MIN_FILL ?? SIZE * 0.1);
const DEADLINE_MIN = Number(process.env.DEADLINE_MIN ?? 10);
const PRIV = process.env.SUPRAFX_DELEGATE_PRIV_HEX!;
const BASE = process.env.SUPRAFX_BASE_URL ?? "https://suprafx.ai";

if (!PRIV) {
  console.error("SUPRAFX_DELEGATE_PRIV_HEX required");
  process.exit(1);
}

const client = new SupraFxClient({ baseUrl: BASE });
const signer = new DelegateSigner({ delegatePrivKeyHex: PRIV, client });

async function main() {
  await signer.loadSequenceFromChain();
  console.log(
    `[auto-partial] delegate=${signer.addressHex} pair=${PAIR} size=${SIZE} floor=${TARGET_RATE} min_fill=${MIN_FILL}`,
  );

  // Resolve native decimals so size/rate scale correctly per asset.
  const assets = await client.listAssets();
  const baseDec =
    assets.find(
      (a) =>
        a.asset_symbol.toUpperCase() === SELL_TOKEN.toUpperCase() &&
        normalizeChain(a.chain_id) === normalizeChain(SELL_CHAIN),
    )?.decimals ?? 18;
  const quoteDec =
    assets.find(
      (a) =>
        a.asset_symbol.toUpperCase() === BUY_TOKEN.toUpperCase() &&
        normalizeChain(a.chain_id) === normalizeChain(BUY_CHAIN),
    )?.decimals ?? 6;

  const floorBft = toRateBFT(TARGET_RATE, baseDec, quoteDec);

  // 1. Submit the resting order: auto-accept + partial fills.
  const rfqIdBytes = randomBytes16();
  const rfqIdHex = bytesToUuid(rfqIdBytes);
  console.log(`[auto-partial] submitting resting rfq ${rfqIdHex.slice(0, 8)}…`);
  const submitResult = await signer.submitRfq({
    pair: derivePairIdFromTokens(SELL_CHAIN, SELL_TOKEN, BUY_CHAIN, BUY_TOKEN),
    base_asset: deriveAssetId(SELL_CHAIN, SELL_TOKEN),
    quote_asset: deriveAssetId(BUY_CHAIN, BUY_TOKEN),
    size: toMicroUnits(SIZE, baseDec),
    reference_price: floorBft,
    // ── The combo ──────────────────────────────────────────────────
    auto_accept: true, //         auto-settle every qualifying quote…
    auto_accept_target_rate: floorBft, //  …at or above this floor…
    allow_partial_fills: true, //          …in slices…
    min_fill_size: toMicroUnits(MIN_FILL, baseDec), // …no smaller than this.
    // ───────────────────────────────────────────────────────────────
    expires_at_ms: BigInt(Date.now() + DEADLINE_MIN * 60 * 1000),
    rfq_id: rfqIdBytes,
    settlement_mode: "Platform",
  });
  if (!submitResult.ok) {
    console.error(`[auto-partial] submit failed: ${submitResult.code}: ${submitResult.detail}`);
    process.exit(1);
  }
  console.log(
    `[auto-partial] ✓ resting order live at batch ${submitResult.batch} — auto-filling at ≥ ${TARGET_RATE}, offline-safe`,
  );

  // 2. Watch the fills roll in. The chain auto-settles each qualifying
  //    quote (we send NO AcceptQuote); we just observe the RFQ's
  //    remaining size shrink and stop when it reaches zero.
  const es = new (EventSource as any)(
    `${BASE}/api/orderbook/feed?pairs=${encodeURIComponent(PAIR)}`,
  );
  let done = false;
  const onRfq = (ev: { data: string }) => {
    const r = JSON.parse(ev.data);
    if (r.id !== rfqIdHex && r.rfq_id !== rfqIdHex) return;
    const remaining = Number(r.remaining_size ?? SIZE);
    const filled = Math.max(0, SIZE - remaining);
    console.log(
      `[auto-partial] ${filled.toFixed(4)}/${SIZE} ${SELL_TOKEN} filled, ${remaining.toFixed(4)} remaining (status=${r.status})`,
    );
    if (!done && (r.status === "matched" || remaining <= 1e-9)) {
      console.log(`[auto-partial] ✓ fully filled`);
      done = true;
      es.close();
      process.exit(0);
    }
  };
  es.addEventListener("rfq_updated", onRfq);
  es.addEventListener("rfq_created", onRfq); // a still-open RFQ re-broadcasts here

  // 3. Deadline — cancel whatever is still unfilled, releasing the earmark.
  setTimeout(async () => {
    if (done) return;
    console.log(`[auto-partial] deadline reached; cancelling unfilled remainder`);
    const c = await signer.cancelRfq({ rfq_id: rfqIdBytes, reason: "deadline" });
    console.log(
      c.ok ? `[auto-partial] ✓ cancelled (earmark released)` : `[auto-partial] cancel failed: ${c.code}`,
    );
    es.close();
    process.exit(0);
  }, DEADLINE_MIN * 60 * 1000);
}

function normalizeChain(chain: string): string {
  if (chain === "eth-mainnet") return "ethereum";
  if (chain === "supra-mainnet") return "supra";
  return chain;
}

function bytesToUuid(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function randomBytes16(): Uint8Array {
  const out = new Uint8Array(16);
  crypto.getRandomValues(out);
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
