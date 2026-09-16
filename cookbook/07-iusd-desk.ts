/**
 * 07 — iAsset (iUSDC / iUSDT) standing-order desk.
 *
 * Keeps one resting auto-accept RFQ on each configured side, sized to
 * USD_SIZE (default $25), posting only when the sell asset's available
 * balance covers it:
 *
 *   SELL sides — offer iUSDC at oracle fair value, auto-accepting any
 *     quote down to DISCOUNT_BPS below fair (default 500 = willing to
 *     sell iUSDC for up to 5% less than market):
 *       iUSDC/USDC, iUSDC/ETH
 *
 *   BUY sides — pay USDC/USDT for iUSDC or iUSDT only at a discount of
 *     DISCOUNT_BPS or more (demand rate >= fair / (1 - d), i.e. we pay
 *     at most 95% of market per iAsset):
 *       USDC/iUSDC, USDT/iUSDC, USDC/iUSDT, USDT/iUSDT
 *
 * Cancels its own resting RFQs on age (AGE_CANCEL_MIN, reposted fresh
 * next cycle) or oracle drift (MOVE_CANCEL_BPS). Only ever touches
 * pairs it manages — the accumulator (05) and seeder (06) books are
 * left alone. DRY_RUN unless LIVE=1.
 *
 * Run (DRY_RUN):
 *   MASTER_ADDRESS=0x... npx tsx cookbook/07-iusd-desk.ts
 * Live: add SUPRAFX_DELEGATE_PRIV_HEX + LIVE=1.
 */
import {
  SupraFxClient,
  DelegateSigner,
  deriveAssetId,
  derivePairIdFromTokens,
  toMicroUnits,
  toRateBFT,
} from "../src/index.js";

const BASE_URL = process.env.SUPRAFX_BASE_URL ?? "https://suprafx.ai";
const MASTER = process.env.MASTER_ADDRESS!;
const PRIV = process.env.SUPRAFX_DELEGATE_PRIV_HEX;
const DRY_RUN = process.env.LIVE !== "1";

const USD_SIZE = Number(process.env.USD_SIZE ?? 25);
const DISCOUNT_BPS = Number(process.env.DISCOUNT_BPS ?? 500);
const MOVE_CANCEL_BPS = Number(process.env.MOVE_CANCEL_BPS ?? 100);
const POLL_MS = Number(process.env.POLL_MS ?? 60000);
const RFQ_EXPIRE_MIN = Number(process.env.RFQ_EXPIRE_MIN ?? 60);
const AGE_CANCEL_MS = Number(process.env.AGE_CANCEL_MIN ?? 45) * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 10000);

const CHAIN: Record<string, string> = {
  USDC: "eth-mainnet",
  USDT: "eth-mainnet",
  ETH: "eth-mainnet",
  IUSDC: "supra-mainnet",
  IUSDT: "supra-mainnet",
};

interface Side {
  sell: string;
  buy: string;
  pair: string;
  /** "sell": advertise fair, accept down to fair*(1-d).
   *  "buy": demand rate >= fair/(1-d) — an iAsset discount of d or more. */
  kind: "sell" | "buy";
}
const SIDES: Side[] = [
  { sell: "iUSDC", buy: "USDC", pair: "iUSDC/USDC", kind: "sell" },
  { sell: "iUSDC", buy: "ETH", pair: "iUSDC/ETH", kind: "sell" },
  { sell: "USDC", buy: "iUSDC", pair: "USDC/iUSDC", kind: "buy" },
  { sell: "USDT", buy: "iUSDC", pair: "USDT/iUSDC", kind: "buy" },
  { sell: "USDC", buy: "iUSDT", pair: "USDC/iUSDT", kind: "buy" },
  { sell: "USDT", buy: "iUSDT", pair: "USDT/iUSDT", kind: "buy" },
];
const sideByPair = new Map(SIDES.map((s) => [s.pair.toUpperCase(), s]));

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

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** One token's USD (≈USDT) price from its native `<token>_usdt` oracle feed. */
async function oracleUsdt(token: string): Promise<number | null> {
  try {
    const r = await fetchWithTimeout(`${BASE_URL}/api/oracle?pair=${token}/USDT`);
    if (!r.ok) return null;
    const j = (await r.json()) as { conversionRate?: number };
    const v = Number(j.conversionRate);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

const lastGoodUsd: Record<string, { price: number; ts: number }> = {};
const USD_CACHE_MAX_MS = Number(process.env.USD_CACHE_MAX_MS ?? 300000);

/** USD price for every token we trade (keyed UPPERCASE). Tolerates a
 *  transient oracle blip via a recent cached price; null if any token has
 *  neither, since we never post mispriced. */
async function usdPrices(): Promise<Record<string, number> | null> {
  const out: Record<string, number> = { USDT: 1 };
  const now = Date.now();
  for (const t of ["USDC", "ETH", "iUSDC", "iUSDT"]) {
    const key = t.toUpperCase();
    const fresh = await oracleUsdt(t);
    if (fresh) {
      lastGoodUsd[key] = { price: fresh, ts: now };
      out[key] = fresh;
    } else if (lastGoodUsd[key] && now - lastGoodUsd[key].ts <= USD_CACHE_MAX_MS) {
      out[key] = lastGoodUsd[key].price;
    } else {
      return null;
    }
  }
  return out;
}

/** Fair rate for "sell SELL, receive BUY" = BUY per SELL. */
function rateOf(sell: string, buy: string, usd: Record<string, number>): number {
  return usd[sell.toUpperCase()] / usd[buy.toUpperCase()];
}

/** The rate we post for a side right now (also used for drift checks). */
function targetOf(side: Side, usd: Record<string, number>): number {
  const fair = rateOf(side.sell, side.buy, usd);
  return side.kind === "buy" ? fair / (1 - DISCOUNT_BPS / 10000) : fair;
}

function isLive(rfq: any, now: number): boolean {
  if (rfq.status !== "open") return false;
  const exp = rfq.expires_at ? Date.parse(rfq.expires_at) : NaN;
  return !Number.isFinite(exp) || exp > now;
}

async function fetchOpenRfqs(): Promise<any[]> {
  const r = await fetchWithTimeout(
    `${BASE_URL}/api/suprafx/rfqs?scope=platform&status=open&limit=200`,
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { data?: any[] };
  const now = Date.now();
  return (j.data ?? []).filter((rfq) => isLive(rfq, now));
}

async function main() {
  console.log(
    DRY_RUN
      ? `[iusd] DRY RUN — logging intended RFQ posts/cancels, signing nothing. Set LIVE=1 to post for real.`
      : `[iusd] LIVE — will POST RFQs with REAL funds (auto_accept resting orders).`,
  );
  if (signer) await signer.loadSequenceFromChain();

  const assets = await client.listAssets();
  const dec = (sym: string) =>
    assets.find(
      (a) =>
        a.asset_symbol.toUpperCase() === sym.toUpperCase() &&
        normalizeChain(a.chain_id) === normalizeChain(CHAIN[sym.toUpperCase()]),
    )?.decimals ?? (sym.toUpperCase().startsWith("IUSD") ? 8 : sym.toUpperCase() === "ETH" ? 18 : 6);

  console.log(
    `[iusd] delegate=${signer?.addressHex ?? "(none — dry run)"} sides=${SIDES.length} ` +
      `size=$${USD_SIZE} discount=${DISCOUNT_BPS}bps cancel_move=${MOVE_CANCEL_BPS}bps ` +
      `age_cancel=${AGE_CANCEL_MS / 60000}min poll=${POLL_MS / 1000}s`,
  );

  const MAX_CONSEC_FAILS = Number(process.env.MAX_CONSEC_FAILS ?? 10);
  let consecFails = 0;
  for (;;) {
    try {
      await pollOnce(dec);
      consecFails = 0;
    } catch (e) {
      consecFails++;
      console.warn(`[iusd] poll error (${consecFails}/${MAX_CONSEC_FAILS}): ${(e as Error).message}`);
      if (consecFails >= MAX_CONSEC_FAILS) {
        console.error(`[iusd] ${consecFails} consecutive failures — exiting for a clean restart.`);
        process.exit(1);
      }
    }
    await sleep(POLL_MS);
  }
}

async function pollOnce(dec: (s: string) => number): Promise<void> {
  const usd = await usdPrices();
  if (!usd) {
    console.warn(`[iusd] oracle USD prices unavailable this cycle; skipping (no posts/cancels).`);
    return;
  }

  const open = await fetchOpenRfqs();

  if (signer) {
    try {
      await signer.loadSequenceFromChain();
    } catch {
      /* transient; keep last known */
    }
  }

  const nowMsCycle = Date.now();
  // Ours AND on a pair this desk manages — never touch the seeder's or
  // accumulator's resting orders.
  const isOursRfq = (r: any) =>
    String(r.taker_address ?? "").toLowerCase() === MASTER.toLowerCase() &&
    sideByPair.has(String(r.pair ?? "").toUpperCase());
  const cancelled = new Set<string>();

  // 1. Cancel our stale orders: too old, or oracle drifted past MOVE_CANCEL_BPS.
  for (const r of open.filter(isOursRfq)) {
    const idStr = String(r.id);
    const side = sideByPair.get(String(r.pair).toUpperCase())!;
    const created = r.created_at ? Date.parse(r.created_at) : NaN;
    const tooOld = Number.isFinite(created) && nowMsCycle - created >= AGE_CANCEL_MS;

    const posted = Number(r.reference_price);
    const nowTarget = targetOf(side, usd);
    const drifted =
      Number.isFinite(posted) &&
      posted > 0 &&
      Math.abs(nowTarget - posted) / posted >= MOVE_CANCEL_BPS / 10000;

    if (!tooOld && !drifted) continue;
    const why = tooOld
      ? `age ${Math.round((nowMsCycle - created) / 60000)}min`
      : `price moved ${(((nowTarget - posted) / posted) * 100).toFixed(2)}%`;
    if (DRY_RUN) {
      console.log(`[iusd] DRY RUN: WOULD cancel ${r.pair} ${idStr.slice(0, 8)} — ${why}`);
    } else {
      const c = await signer!.cancelRfq({
        rfq_id: uuidToBytes16(idStr),
        reason: tooOld ? "age" : "price-move",
      });
      console.log(
        c.ok
          ? `[iusd] ✗ cancelled ${r.pair} ${idStr.slice(0, 8)} — ${why}`
          : `[iusd] cancel failed ${idStr.slice(0, 8)}: ${c.code}: ${c.detail}`,
      );
    }
    cancelled.add(idStr);
  }

  // 2. Balances, for sizing + sufficiency.
  const bal = await client.getBalances(MASTER);
  const avail: Record<string, number> = {};
  for (const b of bal) avail[b.asset.toUpperCase()] = b.available;

  // 3. Ensure one resting order per side (when the sell balance covers it).
  for (const side of SIDES) {
    const oursHere = open.some(
      (r) =>
        isOursRfq(r) &&
        String(r.pair).toUpperCase() === side.pair.toUpperCase() &&
        !cancelled.has(String(r.id)),
    );
    if (oursHere) continue;

    const fair = rateOf(side.sell, side.buy, usd);
    const target = targetOf(side, usd);
    // Sells advertise fair but auto-accept down to fair*(1-d); buys demand
    // the discounted rate outright, so accept == advertised.
    const acceptRate = side.kind === "sell" ? fair * (1 - DISCOUNT_BPS / 10000) : target;

    const size = USD_SIZE / usd[side.sell.toUpperCase()];
    if ((avail[side.sell.toUpperCase()] ?? 0) < size) {
      console.log(
        `[iusd] ${side.pair}: insufficient ${side.sell} (${(avail[side.sell.toUpperCase()] ?? 0).toPrecision(4)} < ${size.toPrecision(4)}); waiting for funds`,
      );
      continue;
    }

    const sellDec = dec(side.sell);
    const buyDec = dec(side.buy);
    const line =
      `${side.pair} ($${USD_SIZE}, ${side.kind}): sell ${size.toPrecision(4)} ${side.sell} @ ${target.toPrecision(6)} ${side.buy}/${side.sell} ` +
      `(oracle ${fair.toPrecision(6)}; auto-accept ≥ ${acceptRate.toPrecision(6)})`;

    if (DRY_RUN) {
      console.log(`[iusd] DRY RUN: WOULD post ${line} — not signing.`);
      continue;
    }

    const rfqId = randomBytes16();
    const rfqIdHex = bytesToUuid(rfqId);
    const chainOf = (sym: string) => CHAIN[sym.toUpperCase()];
    const r = await signer!.submitRfq({
      pair: derivePairIdFromTokens(chainOf(side.sell), side.sell, chainOf(side.buy), side.buy),
      base_asset: deriveAssetId(chainOf(side.sell), side.sell),
      quote_asset: deriveAssetId(chainOf(side.buy), side.buy),
      size: toMicroUnits(size, sellDec),
      reference_price: toRateBFT(target, sellDec, buyDec),
      auto_accept: true,
      auto_accept_target_rate: toRateBFT(acceptRate, sellDec, buyDec),
      allow_partial_fills: false,
      min_fill_size: toMicroUnits(size, sellDec),
      expires_at_ms: BigInt(Date.now() + RFQ_EXPIRE_MIN * 60 * 1000),
      rfq_id: rfqId,
      settlement_mode: "Platform",
    });
    if (r.ok) {
      console.log(`[iusd] ✓ posted ${line} [${rfqIdHex.slice(0, 8)}]`);
    } else {
      console.warn(`[iusd] post failed ${side.pair}: ${r.code}: ${r.detail}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
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
