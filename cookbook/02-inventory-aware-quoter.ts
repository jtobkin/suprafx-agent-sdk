/**
 * 02 — Inventory-aware quoter.
 *
 * Tracks the master's available balance per asset. Refuses to quote
 * if the locked amount would exceed `MAX_INVENTORY_PCT` of available.
 * Widens the spread proportionally as inventory tilts away from
 * 50/50.
 *
 * Run with:
 *   SUPRAFX_DELEGATE_PRIV_HEX=... \
 *   MASTER_ADDRESS=0x... \
 *   PAIR=ETH/USDC \
 *   BASE_SPREAD_BPS=15 \
 *   MAX_INVENTORY_PCT=80 \
 *   npx tsx cookbook/02-inventory-aware-quoter.ts
 */

import EventSource from "eventsource";
import {
  SupraFxClient,
  DelegateSigner,
  toMicroUnits,
  toRateBFT,
} from "../src/index.js";

const PAIR = process.env.PAIR ?? "ETH/USDC";
const BASE_SPREAD_BPS = Number(process.env.BASE_SPREAD_BPS ?? 15);
const MAX_INVENTORY_PCT = Number(process.env.MAX_INVENTORY_PCT ?? 80);
const PRIV = process.env.SUPRAFX_DELEGATE_PRIV_HEX!;
const MASTER = process.env.MASTER_ADDRESS!;
const BASE = process.env.SUPRAFX_BASE_URL ?? "https://suprafx.ai";

if (!PRIV || !MASTER) {
  console.error("SUPRAFX_DELEGATE_PRIV_HEX and MASTER_ADDRESS required");
  process.exit(1);
}

const client = new SupraFxClient({ baseUrl: BASE });
const signer = new DelegateSigner({ delegatePrivKeyHex: PRIV, client });

interface InventoryView {
  base: number;
  quote: number;
}

async function readInventory(baseSym: string, quoteSym: string): Promise<InventoryView> {
  const bal = await client.getBalances(MASTER);
  return {
    base: bal.find((b) => b.asset.toUpperCase() === baseSym)?.available ?? 0,
    quote: bal.find((b) => b.asset.toUpperCase() === quoteSym)?.available ?? 0,
  };
}

/** Spread skew based on inventory tilt. Heavy in base → quote
 *  aggressively (tighter spread). Heavy in quote → quote conservatively. */
function spreadBps(inv: InventoryView, refRate: number): number {
  const totalQuoteValue = inv.quote + inv.base * refRate;
  if (totalQuoteValue <= 0) return BASE_SPREAD_BPS * 3; // empty → wide
  const baseShare = (inv.base * refRate) / totalQuoteValue;
  // tilt = 0 at 50/50, 1 at 100% base, -1 at 100% quote
  const tilt = (baseShare - 0.5) * 2;
  // base spread widens by up to 2× when very tilted
  return BASE_SPREAD_BPS * (1 + Math.abs(tilt));
}

async function main() {
  await signer.loadSequenceFromChain();
  console.log(
    `[inventory-quoter] delegate=${signer.addressHex} pair=${PAIR}`,
  );
  const assets = await client.listAssets();
  const [baseSym, quoteSym] = PAIR.split("/");
  // For this example assume the pair is single-chain on each leg
  // (e.g. ETH/USDC on Ethereum). Decimals lookup just picks the first
  // matching symbol.
  const baseDec =
    assets.find((a) => a.asset_symbol.toUpperCase() === baseSym)?.decimals ?? 18;
  const quoteDec =
    assets.find((a) => a.asset_symbol.toUpperCase() === quoteSym)?.decimals ?? 6;

  const es = new (EventSource as any)(
    `${BASE}/api/orderbook/feed?pairs=${encodeURIComponent(PAIR)}`,
  );

  es.addEventListener("rfq_created", async (ev: { data: string }) => {
    const rfq = JSON.parse(ev.data);
    if (rfq.pair !== PAIR || rfq.status !== "open") return;
    const ref = Number(rfq.reference_price);
    if (!Number.isFinite(ref) || ref <= 0) return;

    const inv = await readInventory(baseSym, quoteSym);
    const fillSize = Math.min(Number(rfq.size), inv.base);
    if (fillSize <= 0) {
      console.log(`[inventory-quoter] no ${baseSym} inventory; skipping rfq=${rfq.id.slice(0, 8)}`);
      return;
    }
    const quoteLock = ref * fillSize;
    if (quoteLock > inv.quote * (MAX_INVENTORY_PCT / 100)) {
      console.log(
        `[inventory-quoter] quote-lock $${quoteLock.toFixed(2)} exceeds ${MAX_INVENTORY_PCT}% of ${quoteSym} balance; skipping`,
      );
      return;
    }
    const bps = spreadBps(inv, ref);
    const quotedRate = ref * (1 - bps / 10000);

    try {
      const r = await signer.placeQuote({
        rfq_id: uuidToBytes16(rfq.id),
        quote_id: randomBytes16(),
        rate: toRateBFT(quotedRate, baseDec, quoteDec),
        fill_size: toMicroUnits(fillSize, baseDec),
      });
      if (r.ok) {
        console.log(
          `[inventory-quoter] ✓ quoted ${fillSize.toFixed(4)} ${baseSym} @ ${quotedRate.toFixed(4)} (spread ${bps.toFixed(1)}bps, batch ${r.batch})`,
        );
      } else {
        console.warn(`[inventory-quoter] rejected: ${r.code}: ${r.detail}`);
      }
    } catch (e) {
      console.error("[inventory-quoter] error:", e);
    }
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
