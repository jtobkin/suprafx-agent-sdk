/**
 * 06 — Multi-market RFQ liquidity seeder.
 *
 * Complements the accumulator (05): instead of quoting on OTHERS' RFQs,
 * this bot POSTS its own RFQs (as taker) to seed visible liquidity across
 * several markets, both directions. Each RFQ is an `auto_accept` resting
 * order — the chain auto-settles any maker quote at or better than our
 * target, so they actually fill.
 *
 * Per cycle (default 60s), for each market side (BASE/QUOTE = we sell
 * BASE for QUOTE):
 *   - If there are fewer than MIN_DEPTH open RFQs that AREN'T ours on that
 *     side — and we don't already have one of our own resting there — post
 *     one, sized to ~RFQ_USD_SIZE (kept small).
 *   - SUPRA sides are priced SUPRA_EDGE_BPS in the COUNTERPARTY's favor
 *     (a better-than-oracle SUPRA offer); non-SUPRA sides price at oracle.
 *   - Any of our resting RFQs is cancelled once the oracle has moved
 *     MOVE_CANCEL_BPS (default 100 = 1%) from where we posted it.
 *
 * Posting an RFQ LOCKS the sell asset until fill/cancel/expiry. This runs
 * DRY_RUN (logs intended posts/cancels, signs nothing) unless LIVE=1.
 *
 * Run (DRY_RUN):
 *   MASTER_ADDRESS=0x... npx tsx cookbook/06-liquidity-seeder.ts
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
import { parsePair } from "../src/asset-registry.js";

const BASE_URL = process.env.SUPRAFX_BASE_URL ?? "https://suprafx.ai";
const MASTER = process.env.MASTER_ADDRESS!;
const PRIV = process.env.SUPRAFX_DELEGATE_PRIV_HEX;
const DRY_RUN = process.env.LIVE !== "1";

const RFQ_USD_SIZE = Number(process.env.RFQ_USD_SIZE ?? 2.5); // per-RFQ notional (<$3)
const SUPRA_EDGE_BPS = Number(process.env.SUPRA_EDGE_BPS ?? 25); // SUPRA offers this much better than oracle
const MIN_DEPTH = Number(process.env.MIN_DEPTH ?? 2); // post when fewer than this many non-ours on a side
const MOVE_CANCEL_BPS = Number(process.env.MOVE_CANCEL_BPS ?? 100); // cancel once oracle moves this far from post (100 = 1%)
const POLL_MS = Number(process.env.POLL_MS ?? 60000); // 1 minute
const RFQ_EXPIRE_MIN = Number(process.env.RFQ_EXPIRE_MIN ?? 60); // on-chain backstop expiry (> AGE_CANCEL so we cancel while live)
const MAX_ACTIVE_RFQS = Number(process.env.MAX_ACTIVE_RFQS ?? 15); // hard cap on our simultaneous open RFQs
const AGE_CANCEL_MS = Number(process.env.AGE_CANCEL_MIN ?? 30) * 60 * 1000; // cancel our RFQs older than this
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 10000);

// Which chain each token settles on.
const CHAIN: Record<string, string> = {
  USDC: "eth-mainnet",
  USDT: "eth-mainnet",
  ETH: "eth-mainnet",
  SUPRA: "supra-mainnet",
};

// Markets to make (unordered); each becomes two directional sides.
const PAIRS: [string, string][] = [
  ["USDC", "USDT"],
  ["USDT", "SUPRA"],
  ["ETH", "USDC"],
  ["ETH", "USDT"],
  ["ETH", "SUPRA"],
];
interface Side {
  sell: string;
  buy: string;
  pair: string;
  isSupra: boolean;
}
const SIDES: Side[] = PAIRS.flatMap(([a, b]) => [
  { sell: a, buy: b, pair: `${a}/${b}`, isSupra: a === "SUPRA" || b === "SUPRA" },
  { sell: b, buy: a, pair: `${b}/${a}`, isSupra: a === "SUPRA" || b === "SUPRA" },
]);

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

// Our live RFQs, keyed by rfq id (uuid string).
const mine = new Map<string, { rfqId: Uint8Array; side: Side; oracleAtPost: number }>();

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** One token's USD (≈USDT) price from its NATIVE `<token>_usdt` oracle feed. */
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

// Last successful USD price per token, so a transient oracle blip doesn't
// stall the whole cycle. Only fall back to a cached price if it's recent.
const lastGoodUsd: Record<string, { price: number; ts: number }> = {};
const USD_CACHE_MAX_MS = Number(process.env.USD_CACHE_MAX_MS ?? 300000); // 5 min

/** USD price of every token we trade, from native feeds — tolerant of a
 *  transient miss (uses a recent cached price). Returns null only if a token
 *  has no fresh AND no recent-cached price, since we never post mispriced. */
async function usdPrices(): Promise<Record<string, number> | null> {
  const out: Record<string, number> = { USDT: 1 };
  const now = Date.now();
  for (const t of ["USDC", "ETH", "SUPRA"]) {
    const fresh = await oracleUsdt(t);
    if (fresh) {
      lastGoodUsd[t] = { price: fresh, ts: now };
      out[t] = fresh;
    } else if (lastGoodUsd[t] && now - lastGoodUsd[t].ts <= USD_CACHE_MAX_MS) {
      out[t] = lastGoodUsd[t].price; // tolerate a blip with a recent price
    } else {
      return null; // no usable price for this token
    }
  }
  return out;
}

/** Fair rate for "sell SELL, receive BUY" = BUY per SELL. */
function rateOf(sell: string, buy: string, usd: Record<string, number>): number {
  return usd[sell] / usd[buy];
}

/** An RFQ is "live" only if it's open AND not past its expiry. The platform
 *  list currently returns expired RFQs still marked open, which otherwise
 *  fools our depth count and makes us think our own expired orders are up. */
function isLive(rfq: any, now: number): boolean {
  if (rfq.status !== "open") return false;
  const exp = rfq.expires_at ? Date.parse(rfq.expires_at) : NaN;
  return !Number.isFinite(exp) || exp > now; // missing/unparseable expiry => treat as live
}

async function fetchOpenRfqs(): Promise<any[]> {
  const r = await fetchWithTimeout(
    `${BASE_URL}/api/suprafx/rfqs?scope=platform&status=open&limit=200`,
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { data?: any[] };
  const now = Date.now();
  return (j.data ?? []).filter((rfq) => isLive(rfq, now)); // drop expired zombies
}

async function main() {
  console.log(
    DRY_RUN
      ? `[seeder] DRY RUN — logging intended RFQ posts/cancels, signing nothing. Set LIVE=1 to post for real.`
      : `[seeder] LIVE — will POST RFQs with REAL funds (auto_accept resting orders).`,
  );
  if (signer) await signer.loadSequenceFromChain();

  const assets = await client.listAssets();
  const dec = (sym: string) =>
    assets.find(
      (a) =>
        a.asset_symbol.toUpperCase() === sym &&
        normalizeChain(a.chain_id) === normalizeChain(CHAIN[sym]),
    )?.decimals ?? (sym === "SUPRA" ? 8 : sym === "ETH" ? 18 : 6);

  console.log(
    `[seeder] delegate=${signer?.addressHex ?? "(none — dry run)"} sides=${SIDES.length} ` +
      `size≈$${RFQ_USD_SIZE} supra_edge=${SUPRA_EDGE_BPS}bps min_depth=${MIN_DEPTH} ` +
      `cancel_move=${MOVE_CANCEL_BPS}bps max_active=${MAX_ACTIVE_RFQS} age_cancel=${AGE_CANCEL_MS / 60000}min poll=${POLL_MS / 1000}s`,
  );

  // Self-heal a stuck connection pool (e.g. after a wifi drop): after
  // MAX_CONSEC_FAILS consecutive poll failures, exit so pm2 relaunches us
  // with fresh sockets. A single success resets the counter.
  const MAX_CONSEC_FAILS = Number(process.env.MAX_CONSEC_FAILS ?? 10);
  let consecFails = 0;
  for (;;) {
    try {
      await pollOnce(dec);
      consecFails = 0;
    } catch (e) {
      consecFails++;
      console.warn(`[seeder] poll error (${consecFails}/${MAX_CONSEC_FAILS}): ${(e as Error).message}`);
      if (consecFails >= MAX_CONSEC_FAILS) {
        console.error(`[seeder] ${consecFails} consecutive failures — exiting for a clean restart (pm2 will relaunch with fresh connections).`);
        process.exit(1);
      }
    }
    await sleep(POLL_MS);
  }
}

async function pollOnce(dec: (s: string) => number): Promise<void> {
  // Price everything off native USD feeds up front; if any is missing we
  // don't post/cancel this cycle rather than risk mispricing.
  const usd = await usdPrices();
  if (!usd) {
    console.warn(`[seeder] oracle USD prices unavailable this cycle; skipping (no posts/cancels).`);
    return;
  }

  const open = await fetchOpenRfqs();
  const openIds = new Set<string>(open.map((r) => String(r.id)));

  // Keep the sequence aligned (same self-heal as the accumulator).
  if (signer) {
    try {
      await signer.loadSequenceFromChain();
    } catch {
      /* transient; keep last known */
    }
  }

  const nowMsCycle = Date.now();
  const isOursRfq = (r: any) => String(r.taker_address ?? "").toLowerCase() === MASTER.toLowerCase();
  const cancelled = new Set<string>(); // ids we cancel this cycle (so counts/depth exclude them)

  // 1a. Age-cancel: cancel any of OUR RFQs older than AGE_CANCEL_MS. Book-based
  //     (uses created_at) so it also cleans up orders left by a prior run.
  for (const r of open.filter(isOursRfq)) {
    const created = r.created_at ? Date.parse(r.created_at) : NaN;
    if (!Number.isFinite(created) || nowMsCycle - created < AGE_CANCEL_MS) continue;
    const ageMin = Math.round((nowMsCycle - created) / 60000);
    if (DRY_RUN) {
      console.log(`[seeder] DRY RUN: WOULD cancel ${r.pair} ${String(r.id).slice(0, 8)} — age ${ageMin}min`);
    } else {
      const c = await signer!.cancelRfq({ rfq_id: uuidToBytes16(String(r.id)), reason: "age" });
      console.log(
        c.ok
          ? `[seeder] ✗ cancelled ${r.pair} ${String(r.id).slice(0, 8)} — age ${ageMin}min`
          : `[seeder] cancel failed ${String(r.id).slice(0, 8)}: ${c.code}: ${c.detail}`,
      );
    }
    cancelled.add(String(r.id));
    mine.delete(String(r.id));
  }

  // Drop in-memory tracking of RFQs that have closed on chain.
  for (const idHex of [...mine.keys()]) {
    if (!openIds.has(idHex)) mine.delete(idHex);
  }

  // 1b. Price-move cancel (book-based): for each of OUR live RFQs, compare the
  //     rate we'd post NOW against the rate it was posted at (its on-book
  //     reference_price). If it has drifted past MOVE_CANCEL_BPS, the resting
  //     offer is stale — the deal is now too far from fair value — so cancel it.
  //     Book-based (not our in-memory set) so it also protects prior-run orders.
  for (const r of open.filter(isOursRfq)) {
    const idStr = String(r.id);
    if (cancelled.has(idStr)) continue; // already age-cancelled this cycle
    const posted = Number(r.reference_price);
    if (!Number.isFinite(posted) || posted <= 0) continue;
    let sell: string, buy: string;
    try {
      const p = parsePair(r.pair);
      sell = p.base;
      buy = p.quote;
    } catch {
      continue;
    }
    if (usd[sell] == null || usd[buy] == null) continue;
    const isSupra = sell === "SUPRA" || buy === "SUPRA";
    const nowTarget = rateOf(sell, buy, usd) * (isSupra ? 1 - SUPRA_EDGE_BPS / 10000 : 1);
    const drift = Math.abs(nowTarget - posted) / posted;
    if (drift < MOVE_CANCEL_BPS / 10000) continue;
    const pct = (((nowTarget - posted) / posted) * 100).toFixed(2);
    if (DRY_RUN) {
      console.log(`[seeder] DRY RUN: WOULD cancel ${r.pair} ${idStr.slice(0, 8)} — price moved ${pct}%`);
    } else {
      const c = await signer!.cancelRfq({ rfq_id: uuidToBytes16(idStr), reason: "price-move" });
      console.log(
        c.ok
          ? `[seeder] ✗ cancelled ${r.pair} ${idStr.slice(0, 8)} — price moved ${pct}%`
          : `[seeder] cancel failed ${idStr.slice(0, 8)}: ${c.code}: ${c.detail}`,
      );
    }
    cancelled.add(idStr);
    mine.delete(idStr);
  }

  // 2. Balances, for sizing + sufficiency.
  const bal = await client.getBalances(MASTER);
  const avail: Record<string, number> = {};
  for (const b of bal) avail[b.asset.toUpperCase()] = b.available;

  // 3. Post to seed thin sides — capped at MAX_ACTIVE_RFQS total.
  let activeCount = open.filter((r) => isOursRfq(r) && !cancelled.has(String(r.id))).length;
  for (const side of SIDES) {
    if (activeCount >= MAX_ACTIVE_RFQS) break; // hard global cap on our open RFQs
    // Judge depth from the actual book by taker address, not our in-memory
    // set — so restarts don't miscount our own resting RFQs as "others".
    const onSide = open.filter((r) => r.pair === side.pair && !cancelled.has(String(r.id)));
    const nonOurs = onSide.filter((r) => !isOursRfq(r)).length;
    const oursHere = onSide.some(isOursRfq); // already have one of ours resting here
    if (nonOurs >= MIN_DEPTH || oursHere) continue;

    const rate = rateOf(side.sell, side.buy, usd); // buy per sell (from native USD feeds)
    // SUPRA sides: shade the rate in the counterparty's favor (we accept
    // fewer buy-per-sell), so users see a better-than-oracle SUPRA offer.
    const target = side.isSupra ? rate * (1 - SUPRA_EDGE_BPS / 10000) : rate;

    const size = RFQ_USD_SIZE / usd[side.sell]; // in sell-token units
    if ((avail[side.sell] ?? 0) < size) {
      console.log(
        `[seeder] ${side.pair}: insufficient ${side.sell} (${(avail[side.sell] ?? 0).toPrecision(4)} < ${size.toPrecision(4)}); skipping`,
      );
      continue;
    }

    const sellDec = dec(side.sell);
    const buyDec = dec(side.buy);
    const line =
      `${side.pair}: sell ${size.toPrecision(4)} ${side.sell} @ ${target.toPrecision(6)} ${side.buy}/${side.sell} ` +
      `(oracle ${rate.toPrecision(6)}${side.isSupra ? `, -${SUPRA_EDGE_BPS}bps for counterparty` : ""})`;

    if (DRY_RUN) {
      console.log(`[seeder] DRY RUN: WOULD post ${line} — not signing.`);
      activeCount++;
      // Reserve locally so we don't "would post" the same side twice per run.
      mine.set(`dry-${side.pair}-${[...mine.keys()].length}`, {
        rfqId: new Uint8Array(16),
        side,
        oracleAtPost: rate,
      });
      continue;
    }

    const rfqId = randomBytes16();
    const rfqIdHex = bytesToUuid(rfqId);
    const r = await signer!.submitRfq({
      pair: derivePairIdFromTokens(CHAIN[side.sell], side.sell, CHAIN[side.buy], side.buy),
      base_asset: deriveAssetId(CHAIN[side.sell], side.sell),
      quote_asset: deriveAssetId(CHAIN[side.buy], side.buy),
      size: toMicroUnits(size, sellDec),
      reference_price: toRateBFT(target, sellDec, buyDec),
      auto_accept: true,
      auto_accept_target_rate: toRateBFT(target, sellDec, buyDec),
      allow_partial_fills: false,
      min_fill_size: toMicroUnits(size, sellDec),
      expires_at_ms: BigInt(nowMs() + RFQ_EXPIRE_MIN * 60 * 1000),
      rfq_id: rfqId,
      settlement_mode: "Platform",
    });
    if (r.ok) {
      mine.set(rfqIdHex, { rfqId, side, oracleAtPost: rate });
      activeCount++;
      console.log(`[seeder] ✓ posted ${line} [${rfqIdHex.slice(0, 8)}]`);
    } else {
      console.warn(`[seeder] post failed ${side.pair}: ${r.code}: ${r.detail}`);
    }
  }
}

function nowMs(): number {
  return Date.now();
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
