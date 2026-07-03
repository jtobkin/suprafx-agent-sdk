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
 * Discovery: the orderbook "feed" is poll-oriented — it emits a single
 * `connected` event with `{pollInterval:1000}` and does not hold a
 * durable stream, so this agent POLLS the REST orderbook every
 * `POLL_MS` (default 2000). Reliable, no missed RFQs, no reconnect noise.
 *
 * Safeguards:
 *   - MAX_SPEND_<ASSET> (e.g. MAX_SPEND_USDC=50) — a soft session cap on
 *     actual settled spend per quote asset, measured from real balance
 *     deltas (resets on restart; the delegate earmark cap is the hard
 *     on-chain backstop).
 *   - QUOTE_TTL_MS (default 30000) — withdraw unmatched bids older than
 *     this so a bid never lingers at a stale oracle price; the RFQ is
 *     then eligible to be re-bid at the fresh price.
 *   - Prints a periodic session summary (SUPRA accumulated + spend).
 *
 * Run (DRY_RUN by default — observes + logs, signs nothing):
 *   MASTER_ADDRESS=0x... QUOTE_ASSETS=USDC,USDT,ETH MAX_PREMIUM_BPS=25 \
 *   npx tsx cookbook/04-bullish-supra-accumulator.ts
 *
 * Go live (real quotes, real funds) by adding SUPRAFX_DELEGATE_PRIV_HEX + LIVE=1.
 */
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
const POLL_MS = Number(process.env.POLL_MS ?? 2000); // orderbook poll cadence
const QUOTE_TTL_MS = Number(process.env.QUOTE_TTL_MS ?? 30000); // withdraw bids older than this
const SUMMARY_MS = Number(process.env.SUMMARY_MS ?? 60000); // session summary cadence
const MASTER = process.env.MASTER_ADDRESS!;
const PRIV = process.env.SUPRAFX_DELEGATE_PRIV_HEX;

// Per-quote-asset soft spend cap (session), e.g. MAX_SPEND_USDC=50.
const SPEND_CAP: Record<string, number> = {};
for (const q of QUOTE_ASSETS) {
  const v = process.env[`MAX_SPEND_${q}`];
  SPEND_CAP[q] = v ? Number(v) : Infinity;
}

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

const seen = new Set<string>(); // RFQ ids already bid (bid once each unless refreshed)
const placed = new Map<string, { quote_id: Uint8Array; ts: number }>(); // live open bids
let startTotals: Record<string, number> | null = null; // baseline for spend/PnL
let lastSummary = 0;

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

/** Open RFQs where a taker is selling SUPRA (SUPRA is the base). */
async function fetchSupraSellers(): Promise<any[]> {
  const r = await fetch(
    `${BASE_URL}/api/suprafx/rfqs?scope=platform&status=open&limit=100`,
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { data?: any[] };
  return (j.data ?? []).filter(
    (rfq) => rfq.status === "open" && PAIRS.includes(rfq.pair),
  );
}

async function main() {
  console.log(
    DRY_RUN
      ? `[accumulator] DRY RUN — polling for SUPRA sellers, logging bids only, signing nothing. Set LIVE=1 to buy with real funds.`
      : `[accumulator] LIVE — will BUY SUPRA with REAL funds (paying ${QUOTE_ASSETS.join("/")}).`,
  );
  if (signer) await signer.loadSequenceFromChain();

  const assets = await client.listAssets();
  const dec = (sym: string) =>
    assets.find((a) => a.asset_symbol.toUpperCase() === sym)?.decimals ??
    (sym === "SUPRA" ? 8 : sym === "ETH" ? 18 : 6);
  const SUPRA_DEC = dec("SUPRA");

  const caps = QUOTE_ASSETS.map((q) =>
    `${q}${SPEND_CAP[q] === Infinity ? "" : "≤" + SPEND_CAP[q]}`,
  ).join(",");
  console.log(
    `[accumulator] delegate=${signer?.addressHex ?? "(none — dry run)"} pairs=${PAIRS.join(", ")} ` +
      `max_premium=${MAX_PREMIUM_BPS}bps poll=${POLL_MS}ms ttl=${QUOTE_TTL_MS}ms spend_caps=${caps}`,
  );

  // Poll loop: sequential, never overlapping, resilient to transient errors.
  for (;;) {
    try {
      await pollOnce(dec, SUPRA_DEC);
    } catch (e) {
      console.warn(`[accumulator] poll error (continuing): ${(e as Error).message}`);
    }
    await sleep(POLL_MS);
  }
}

async function pollOnce(dec: (s: string) => number, SUPRA_DEC: number): Promise<void> {
  // Fresh balance snapshot every cycle (drives budget, spend caps, PnL).
  const bal = await client.getBalances(MASTER);
  const avail: Record<string, number> = {};
  const total: Record<string, number> = {};
  for (const b of bal) {
    avail[b.asset.toUpperCase()] = b.available;
    total[b.asset.toUpperCase()] = b.total;
  }
  if (!startTotals) startTotals = { ...total };

  await withdrawStaleBids();
  maybeSummary(total);

  // Effective budget per quote asset = min(available, remaining spend cap).
  const budget: Record<string, number> = {};
  for (const q of QUOTE_ASSETS) {
    const spent = Math.max(0, (startTotals[q] ?? 0) - (total[q] ?? 0));
    const capLeft = SPEND_CAP[q] - spent; // Infinity if uncapped
    budget[q] = Math.max(0, Math.min(avail[q] ?? 0, capLeft));
  }

  const fresh = (await fetchSupraSellers()).filter((rfq) => !seen.has(rfq.id));
  for (const rfq of fresh) {
    seen.add(rfq.id);
    await evaluate(rfq, budget, dec, SUPRA_DEC);
  }
}

/** Withdraw any live bid older than QUOTE_TTL_MS so it never lingers at a
 *  stale oracle price. The RFQ becomes eligible to be re-bid fresh. */
async function withdrawStaleBids(): Promise<void> {
  if (DRY_RUN || placed.size === 0) return;
  const now = Date.now();
  for (const [rfqId, q] of placed) {
    if (now - q.ts < QUOTE_TTL_MS) continue;
    try {
      const r = await signer!.withdrawQuote({ quote_id: q.quote_id });
      if (r.ok) {
        console.log(
          `[accumulator] ↩ withdrew stale bid on ${rfqId.slice(0, 8)} (age ${Math.round((now - q.ts) / 1000)}s)`,
        );
      }
    } catch {
      /* quote may already be filled/gone; ignore */
    }
    placed.delete(rfqId);
    seen.delete(rfqId); // allow a fresh bid if the RFQ is still open
  }
}

function maybeSummary(total: Record<string, number>): void {
  const now = Date.now();
  if (now - lastSummary < SUMMARY_MS || !startTotals) return;
  lastSummary = now;
  const supraGain = (total["SUPRA"] ?? 0) - (startTotals["SUPRA"] ?? 0);
  const spends = QUOTE_ASSETS.map(
    (q) => `${Math.max(0, (startTotals![q] ?? 0) - (total[q] ?? 0)).toPrecision(4)} ${q}`,
  ).join(", ");
  console.log(
    `[accumulator] 📊 session: +${supraGain.toFixed(2)} SUPRA accumulated; spent ${spends}; open bids ${placed.size}`,
  );
}

/** Evaluate one SUPRA-seller RFQ and (in LIVE) place a buy quote.
 *  Mutates `budget` to reserve spent funds for the rest of this cycle. */
async function evaluate(
  rfq: any,
  budget: Record<string, number>,
  dec: (s: string) => number,
  SUPRA_DEC: number,
): Promise<void> {
  try {
    const { base, quote } = parsePair(rfq.pair);
    if (base !== "SUPRA") return; // must be a SUPRA seller

    const oracle = await oracleQperSupra(rfq.pair); // Q per SUPRA
    if (!oracle) {
      console.log(`[accumulator] no oracle for ${rfq.pair}; skipping ${String(rfq.id).slice(0, 8)}`);
      return;
    }
    const ceiling = oracle * (1 + MAX_PREMIUM_BPS / 10000); // never pay above this

    const budgetQ = budget[quote] ?? 0; // available ∩ remaining spend cap, minus this-cycle reservations
    const rfqSize = Number(rfq.remaining_size ?? rfq.size); // SUPRA offered
    const fillSupra = Math.min(rfqSize, budgetQ / ceiling);

    if (!(fillSupra >= MIN_SUPRA_FILL)) {
      console.log(
        `[accumulator] ${rfq.pair} ${String(rfq.id).slice(0, 8)}: only ${fillSupra.toFixed(2)} SUPRA affordable ` +
          `(budget ${budgetQ.toPrecision(4)} ${quote}); < MIN_SUPRA_FILL=${MIN_SUPRA_FILL}; skipping`,
      );
      return;
    }

    const qSpend = fillSupra * ceiling;
    const qDec = dec(quote);
    const line =
      `${fillSupra.toFixed(2)} SUPRA for ${qSpend.toPrecision(6)} ${quote} ` +
      `@ ${ceiling.toPrecision(6)} ${quote}/SUPRA (oracle ${oracle.toPrecision(6)}, +${MAX_PREMIUM_BPS}bps)`;

    if (DRY_RUN) {
      budget[quote] = budgetQ - qSpend; // reserve so we don't "would buy" past budget
      console.log(`[accumulator] DRY RUN: WOULD buy ${line} — not signing.`);
      return;
    }

    const quoteId = randomBytes16();
    const r = await signer!.placeQuote({
      rfq_id: uuidToBytes16(rfq.id),
      quote_id: quoteId,
      rate: toRateBFT(ceiling, SUPRA_DEC, qDec),
      fill_size: toMicroUnits(fillSupra, SUPRA_DEC),
    });
    if (r.ok) {
      budget[quote] = budgetQ - qSpend; // reserve committed spend for this cycle
      placed.set(rfq.id, { quote_id: quoteId, ts: Date.now() });
      console.log(`[accumulator] ✓ bid to buy ${line} (batch ${r.batch})`);
    } else {
      console.warn(`[accumulator] rejected (${rfq.pair}): ${r.code}: ${r.detail}`);
    }
  } catch (e) {
    console.error("[accumulator] error:", e);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
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
