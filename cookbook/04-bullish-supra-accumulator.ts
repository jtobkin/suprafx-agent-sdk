/**
 * 04 — Bullish SUPRA accumulator.
 *
 * Expresses a BULLISH view: accumulate SUPRA by quoting to BUY it
 * whenever someone opens an RFQ to SELL SUPRA — but never paying more
 * than the oracle price plus a small premium.
 *
 * Which RFQs? Direction is encoded by pair ordering (BASE/QUOTE = taker
 * sells BASE, receives QUOTE). So a taker SELLING SUPRA shows up as a
 * `SUPRA/<quote>` RFQ. We watch SUPRA/USDC, SUPRA/USDT, SUPRA/ETH and,
 * as maker, pay the quote asset to receive SUPRA (accumulate).
 *
 * Price rule: for each RFQ we read the live oracle
 * (`/api/oracle?pair=SUPRA/Q` → conversionRate = Q per SUPRA) and bid at
 * oracle × (1 + MAX_PREMIUM_BPS/1e4). We NEVER bid above that ceiling,
 * so we only ever pay up to MAX_PREMIUM_BPS over oracle. Size is capped
 * by the RFQ size and our available balance of the quote asset.
 *
 * The maker locks the QUOTE asset, so your delegate policy must have
 * caps enabled for every quote asset you list (USDC, USDT, ETH).
 *
 * Run (DRY_RUN by default — observes + logs, signs nothing):
 *   MASTER_ADDRESS=0x... \
 *   QUOTE_ASSETS=USDC,USDT,ETH \
 *   MAX_PREMIUM_BPS=25 \
 *   npx tsx cookbook/04-bullish-supra-accumulator.ts
 *
 * Go live (real quotes, real funds) by adding SUPRAFX_DELEGATE_PRIV_HEX + LIVE=1.
 */
import { EventSource } from "eventsource";
import {
  SupraFxClient,
  DelegateSigner,
  toMicroUnits,
  toRateBFT,
} from "../src/index.js";
import { parsePair } from "../src/asset-registry.js";

const BASE_URL = process.env.SUPRAFX_BASE_URL ?? "https://suprafx.ai";
const QUOTE_ASSETS = (process.env.QUOTE_ASSETS ?? "USDC,USDT,ETH")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const MAX_PREMIUM_BPS = Number(process.env.MAX_PREMIUM_BPS ?? 25); // pay up to +0.25% over oracle
const MIN_SUPRA_FILL = Number(process.env.MIN_SUPRA_FILL ?? 1); // ignore dust fills
const MASTER = process.env.MASTER_ADDRESS!;
const PRIV = process.env.SUPRAFX_DELEGATE_PRIV_HEX;

// Safety: buying SUPRA locks quote-asset funds. DRY_RUN unless LIVE=1.
const DRY_RUN = process.env.LIVE !== "1";

if (!MASTER) {
  console.error("MASTER_ADDRESS required (read-only balance lookups)");
  process.exit(1);
}
if (!DRY_RUN && !PRIV) {
  console.error("SUPRAFX_DELEGATE_PRIV_HEX required for a LIVE run");
  process.exit(1);
}

const client = new SupraFxClient({ baseUrl: BASE_URL });
const signer = PRIV ? new DelegateSigner({ delegatePrivKeyHex: PRIV, client }) : null;

const PAIRS = QUOTE_ASSETS.map((q) => `SUPRA/${q}`);

/** Live oracle price for SUPRA in the given quote asset (Q per SUPRA). */
async function oracleQperSupra(pair: string): Promise<number | null> {
  try {
    const r = await fetch(`${BASE_URL}/api/oracle?pair=${encodeURIComponent(pair)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { conversionRate?: number };
    const rate = Number(j.conversionRate);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

async function availableBalance(symbol: string): Promise<number> {
  const bal = await client.getBalances(MASTER);
  return bal.find((b) => b.asset.toUpperCase() === symbol)?.available ?? 0;
}

async function main() {
  console.log(
    DRY_RUN
      ? `[accumulator] DRY RUN — watching for SUPRA sellers, logging bids only, signing nothing. Set LIVE=1 to buy with real funds.`
      : `[accumulator] LIVE — will BUY SUPRA with REAL funds (paying ${QUOTE_ASSETS.join("/")}).`,
  );
  if (signer) await signer.loadSequenceFromChain();

  const assets = await client.listAssets();
  const dec = (sym: string) =>
    assets.find((a) => a.asset_symbol.toUpperCase() === sym)?.decimals ??
    (sym === "SUPRA" ? 8 : sym === "ETH" ? 18 : 6);
  const SUPRA_DEC = dec("SUPRA");

  console.log(
    `[accumulator] delegate=${signer?.addressHex ?? "(none — dry run)"} pairs=${PAIRS.join(", ")} max_premium=${MAX_PREMIUM_BPS}bps`,
  );

  for (const pair of PAIRS) {
    const es = new (EventSource as any)(
      `${BASE_URL}/api/orderbook/feed?pairs=${encodeURIComponent(pair)}`,
    );
    es.addEventListener("rfq_created", (ev: { data: string }) => {
      void handleRfq(JSON.parse(ev.data), dec, SUPRA_DEC);
    });
    es.addEventListener("error", () => {
      console.warn(`[accumulator] feed error on ${pair} (will keep retrying)`);
    });
  }
  console.log(`[accumulator] subscribed. Waiting for SUPRA sellers…`);
}

async function handleRfq(
  rfq: any,
  dec: (s: string) => number,
  SUPRA_DEC: number,
): Promise<void> {
  try {
    if (rfq.status !== "open") return;
    if (!PAIRS.includes(rfq.pair)) return;
    const { base, quote } = parsePair(rfq.pair);
    if (base !== "SUPRA") return; // must be a SUPRA seller (SUPRA is base)

    const oracle = await oracleQperSupra(rfq.pair); // Q per SUPRA
    if (!oracle) {
      console.log(`[accumulator] no oracle for ${rfq.pair}; skipping ${String(rfq.id).slice(0, 8)}`);
      return;
    }
    const ceiling = oracle * (1 + MAX_PREMIUM_BPS / 10000); // never pay above this

    const availableQ = await availableBalance(quote);
    const rfqSize = Number(rfq.remaining_size ?? rfq.size); // SUPRA offered
    const maxByBudget = availableQ / ceiling; // SUPRA we can afford
    const fillSupra = Math.min(rfqSize, maxByBudget);

    if (!(fillSupra >= MIN_SUPRA_FILL)) {
      console.log(
        `[accumulator] ${rfq.pair} ${String(rfq.id).slice(0, 8)}: can only fill ${fillSupra.toFixed(2)} SUPRA ` +
          `(avail ${availableQ} ${quote}); below MIN_SUPRA_FILL=${MIN_SUPRA_FILL}; skipping`,
      );
      return;
    }

    const qSpend = fillSupra * ceiling;
    const qDec = dec(quote);
    const line =
      `${fillSupra.toFixed(2)} SUPRA for ${qSpend.toPrecision(6)} ${quote} ` +
      `@ ${ceiling.toPrecision(6)} ${quote}/SUPRA (oracle ${oracle.toPrecision(6)}, +${MAX_PREMIUM_BPS}bps)`;

    if (DRY_RUN) {
      console.log(`[accumulator] DRY RUN: WOULD buy ${line} — not signing.`);
      return;
    }

    const r = await signer!.placeQuote({
      rfq_id: uuidToBytes16(rfq.id),
      quote_id: randomBytes16(),
      rate: toRateBFT(ceiling, SUPRA_DEC, qDec),
      fill_size: toMicroUnits(fillSupra, SUPRA_DEC),
    });
    if (r.ok) {
      console.log(`[accumulator] ✓ bid to buy ${line} (batch ${r.batch})`);
    } else {
      console.warn(`[accumulator] rejected (${rfq.pair}): ${r.code}: ${r.detail}`);
    }
  } catch (e) {
    console.error("[accumulator] error:", e);
  }
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
