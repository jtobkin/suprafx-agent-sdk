/**
 * 01 — Passive quoter.
 *
 * The simplest market maker. Subscribes to one pair on the live SSE
 * feed. For every new RFQ it sees, posts a quote at reference price +
 * a fixed spread.
 *
 * Run with:
 *   SUPRAFX_DELEGATE_PRIV_HEX=... \
 *   PAIR=ETH/USDC \
 *   SPREAD_BPS=10 \
 *   npx tsx cookbook/01-passive-quoter.ts
 *
 * The delegate must have caps for both the base AND quote assets of
 * the pair (you're locking quote_asset on every quote).
 */

import EventSource from "eventsource";
import { SupraFxClient, DelegateSigner } from "../src/index.js";

const PAIR = process.env.PAIR ?? "ETH/USDC";
const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? 10);
const PRIV = process.env.SUPRAFX_DELEGATE_PRIV_HEX;
const BASE = process.env.SUPRAFX_BASE_URL ?? "https://suprafx.ai";

if (!PRIV) {
  console.error("SUPRAFX_DELEGATE_PRIV_HEX env var required");
  process.exit(1);
}

const client = new SupraFxClient({ baseUrl: BASE });
const signer = new DelegateSigner({ delegatePrivKeyHex: PRIV, client });

async function main() {
  await signer.loadSequenceFromChain();
  console.log(
    `[passive-quoter] delegate=${signer.addressHex} pair=${PAIR} spread=${SPREAD_BPS}bps`,
  );

  const es = new (EventSource as any)(
    `${BASE}/api/orderbook/feed?pairs=${encodeURIComponent(PAIR)}`,
  );

  es.addEventListener("rfq_created", async (ev: { data: string }) => {
    const rfq = JSON.parse(ev.data);
    if (rfq.pair !== PAIR) return;
    if (rfq.status !== "open") return;
    // Skew the price by the spread, on the taker's side.
    // Taker SELLS base, RECEIVES quote → maker pays out quote.
    // Maker offers fewer quote per base = better margin.
    const ref = Number(rfq.reference_price);
    if (!Number.isFinite(ref) || ref <= 0) return;
    const skew = 1 - SPREAD_BPS / 10000;
    const quotedRate = ref * skew;
    const fillSize = Number(rfq.size);
    const totalPayment = quotedRate * fillSize;

    try {
      // place_quote via the MCP tool path is too high-level here.
      // Use the SDK directly with the helper that handles asset
      // resolution. To keep this example simple, we re-fetch the
      // pair decimals (cached internally by SupraFxClient).
      const assets = await client.listAssets();
      const [baseSym, quoteSym] = PAIR.split("/");
      const baseDec = assets.find(
        (a) =>
          a.asset_symbol.toUpperCase() === baseSym &&
          ((a.chain_id === "ethereum" && rfq.source_chain === "ethereum") ||
            (a.chain_id === "supra" && rfq.source_chain === "supra")),
      )?.decimals;
      const quoteDec = assets.find(
        (a) =>
          a.asset_symbol.toUpperCase() === quoteSym &&
          ((a.chain_id === "ethereum" && rfq.dest_chain === "ethereum") ||
            (a.chain_id === "supra" && rfq.dest_chain === "supra")),
      )?.decimals;
      if (baseDec == null || quoteDec == null) {
        console.warn("[passive-quoter] could not resolve decimals; skipping");
        return;
      }

      // Direct SDK call. For a cleaner integration, build a small
      // wrapper around DelegateSigner.placeQuote that takes
      // (fillSize, totalPayment, baseDec, quoteDec) and does the
      // toMicroUnits / toRateBFT conversion.
      const { toMicroUnits, toRateBFT } = await import("../src/index.js");
      const result = await signer.placeQuote({
        rfq_id: uuidToBytes16(rfq.id),
        quote_id: randomBytes16(),
        rate: toRateBFT(quotedRate, baseDec, quoteDec),
        fill_size: toMicroUnits(fillSize, baseDec),
      });
      if (result.ok) {
        console.log(
          `[passive-quoter] ✓ quoted ${fillSize} ${baseSym} @ ${quotedRate.toFixed(6)} (batch ${result.batch})`,
        );
      } else {
        console.warn(
          `[passive-quoter] quote rejected: ${result.code}: ${result.detail}`,
        );
      }
    } catch (e) {
      console.error("[passive-quoter] error:", e);
    }
  });

  es.addEventListener("heartbeat", () => {
    /* keep-alive */
  });
}

function uuidToBytes16(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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
