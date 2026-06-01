/**
 * 03 — Counter-arb taker.
 *
 * Watches OTHER maker quotes on the orderbook and accepts any whose
 * rate is favorable enough — i.e. if a maker offers to fill your RFQ
 * better than your reference price by `MIN_EDGE_BPS`, accept it.
 *
 * Run as a complement to a passive-quoter: it submits the RFQ, this
 * agent accepts the winning quote. Demonstrates the full
 * SubmitRfq → wait → AcceptQuote round-trip from the taker side.
 *
 * Run with:
 *   SUPRAFX_DELEGATE_PRIV_HEX=... \
 *   PAIR=ETH/USDC \
 *   SELL_CHAIN=eth-mainnet SELL_TOKEN=ETH \
 *   BUY_CHAIN=eth-mainnet  BUY_TOKEN=USDC \
 *   SIZE=0.1 REFERENCE_RATE=2400 MIN_EDGE_BPS=20 \
 *   npx tsx cookbook/03-counter-arb-taker.ts
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
const SIZE = Number(process.env.SIZE ?? 0.1);
const REF_RATE = Number(process.env.REFERENCE_RATE ?? 2400);
const MIN_EDGE_BPS = Number(process.env.MIN_EDGE_BPS ?? 20);
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
    `[arb-taker] delegate=${signer.addressHex} pair=${PAIR} size=${SIZE} ref=${REF_RATE} min_edge=${MIN_EDGE_BPS}bps`,
  );
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

  // 1. Submit the RFQ.
  const rfqIdBytes = randomBytes16();
  const rfqIdHex = bytesToUuid(rfqIdBytes);
  console.log(`[arb-taker] submitting rfq ${rfqIdHex.slice(0, 8)}…`);
  const submitResult = await signer.submitRfq({
    pair: derivePairIdFromTokens(SELL_CHAIN, SELL_TOKEN, BUY_CHAIN, BUY_TOKEN),
    base_asset: deriveAssetId(SELL_CHAIN, SELL_TOKEN),
    quote_asset: deriveAssetId(BUY_CHAIN, BUY_TOKEN),
    size: toMicroUnits(SIZE, baseDec),
    reference_price: toRateBFT(REF_RATE, baseDec, quoteDec),
    auto_accept: false,
    auto_accept_target_rate: BigInt(0),
    allow_partial_fills: false,
    min_fill_size: BigInt(0),
    expires_at_ms: BigInt(Date.now() + 5 * 60 * 1000),
    rfq_id: rfqIdBytes,
    settlement_mode: "Platform",
  });
  if (!submitResult.ok) {
    console.error(`[arb-taker] rfq submit failed: ${submitResult.code}: ${submitResult.detail}`);
    process.exit(1);
  }
  console.log(`[arb-taker] ✓ rfq committed at batch ${submitResult.batch}`);

  // 2. Subscribe to incoming quotes; accept any with edge ≥ MIN_EDGE_BPS.
  const es = new (EventSource as any)(
    `${BASE}/api/orderbook/feed?pairs=${encodeURIComponent(PAIR)}`,
  );
  let accepted = false;
  es.addEventListener("quote_placed", async (ev: { data: string }) => {
    if (accepted) return;
    const q = JSON.parse(ev.data);
    if (q.rfq_id !== rfqIdHex) return;
    const rate = Number(q.rate);
    if (!Number.isFinite(rate) || rate <= 0) return;
    // Edge: how much better than reference are we getting?
    // Taker is selling base for quote → wants MAX (quote per base) → max rate.
    const edgeBps = ((rate - REF_RATE) / REF_RATE) * 10000;
    if (edgeBps >= MIN_EDGE_BPS) {
      console.log(
        `[arb-taker] accepting quote ${q.id.slice(0, 8)} @ ${rate.toFixed(4)} (edge ${edgeBps.toFixed(1)}bps)`,
      );
      accepted = true;
      const r = await signer.acceptQuote({
        quote_id: uuidToBytes16(q.id),
        trade_id: randomBytes16(),
      });
      if (r.ok) {
        console.log(`[arb-taker] ✓ accepted at batch ${r.batch}`);
      } else {
        console.error(`[arb-taker] accept failed: ${r.code}: ${r.detail}`);
      }
      es.close();
      process.exit(0);
    } else {
      console.log(
        `[arb-taker] quote ${q.id.slice(0, 8)} @ ${rate.toFixed(4)} edge ${edgeBps.toFixed(1)}bps < ${MIN_EDGE_BPS}; skip`,
      );
    }
  });

  // 3. Timeout — give up if no acceptable quote arrives.
  setTimeout(async () => {
    if (accepted) return;
    console.log(`[arb-taker] no acceptable quote in 5 min; cancelling rfq`);
    await signer.cancelRfq({ rfq_id: rfqIdBytes, reason: "no_edge" });
    process.exit(0);
  }, 5 * 60 * 1000);
}

function normalizeChain(chain: string): string {
  if (chain === "eth-mainnet") return "ethereum";
  if (chain === "supra-mainnet") return "supra";
  return chain;
}

function uuidToBytes16(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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
