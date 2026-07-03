# Cookbook — runnable agent examples

These are pasta-ready starting points. Each file is self-contained,
runs against the live `suprafx.ai` chain, and **defaults to `DRY_RUN`**
— it observes the real book and logs what it *would* do, signing and
submitting nothing until you set `LIVE=1`.

> **Most people here are bullish SUPRA — so these examples are framed
> around _accumulating_ SUPRA (buying it), not distributing it.** Read
> the direction primer below before you run anything, so you never
> accidentally quote the sell side.

## Which direction am I trading? (read this first)

On SupraFX a pair is written `BASE/QUOTE`, and **the taker sells BASE
and receives QUOTE**. As a **maker** you take the other side: you
**pay the QUOTE asset and receive the BASE asset**.

So to **BUY / accumulate SUPRA**, you want RFQs where **SUPRA is the
BASE** — i.e. someone selling SUPRA:

| RFQ pair | Taker is… | You (maker) … | SUPRA effect |
|---|---|---|---|
| `SUPRA/USDC` | selling SUPRA for USDC | pay USDC, **get SUPRA** | ✅ accumulate |
| `SUPRA/USDT` | selling SUPRA for USDT | pay USDT, **get SUPRA** | ✅ accumulate |
| `SUPRA/ETH`  | selling SUPRA for ETH  | pay ETH,  **get SUPRA** | ✅ accumulate |
| `USDC/SUPRA` | selling USDC for SUPRA | pay SUPRA, get USDC | ❌ distributes SUPRA |
| `USDT/SUPRA` | selling USDT for SUPRA | pay SUPRA, get USDC | ❌ distributes SUPRA |

**The maker locks the QUOTE asset.** To accumulate SUPRA you fund and
enable delegate caps for the assets you *pay* (USDC / USDT / ETH), not
SUPRA.

## Prerequisites

1. A delegate keypair authorized on chain by your master StarKey.
   Generate one locally with **[`00-generate-delegate-key.ts`](./00-generate-delegate-key.ts)**
   (private key never touches the browser), then register the printed
   public key on suprafx.ai → Profile → Delegates.
2. Deposited balances + **enabled delegate caps for every asset you pay**
   (deny-by-default: an unchecked asset can't be traded).
3. `npm install` in the parent `agent-sdk/` directory.

---

## ⭐ Flagship: `04-bullish-supra-accumulator.ts`

**Accumulate SUPRA at a fair price.** Watches `SUPRA/USDC`,
`SUPRA/USDT`, `SUPRA/ETH` for anyone selling SUPRA and bids to **buy**
it at **up to the oracle price + `MAX_PREMIUM_BPS`** (never higher),
sized to your available balance. This is the bullish default.

```bash
# DRY_RUN — watch it evaluate live SUPRA sellers, sign nothing:
MASTER_ADDRESS=0x... \
QUOTE_ASSETS=USDC,USDT,ETH \
MAX_PREMIUM_BPS=25 \
npx tsx 04-bullish-supra-accumulator.ts

# LIVE — add your delegate key + LIVE=1 to actually buy:
SUPRAFX_DELEGATE_PRIV_HEX=0x... LIVE=1 \
MASTER_ADDRESS=0x... QUOTE_ASSETS=USDC,USDT,ETH MAX_PREMIUM_BPS=25 \
npx tsx 04-bullish-supra-accumulator.ts
```

**Knobs:** `MAX_PREMIUM_BPS=0` buys only at oracle; a **negative** value
(e.g. `-50`) only buys 0.5% *below* oracle (more patient, cheaper).
`QUOTE_ASSETS` trims which assets you'll spend.

**Good for:** expressing a bullish view — steadily buying SUPRA from
sellers without ever overpaying the oracle.

---

## Mechanics examples

The three below teach the maker/taker plumbing. **As written, `01` and
`02` quote the _sell-SUPRA_ side of a `<quote>/SUPRA` pair** — run them
on a `SUPRA/<quote>` pair (or study `04`) if your intent is to buy.

### `01-passive-quoter.ts`
Simplest maker. For every new RFQ on one pair, posts a quote at
reference price ± a fixed spread. No inventory tracking, no exit logic.
DRY_RUN unless `LIVE=1`.

```bash
PAIR=SUPRA/USDC SPREAD_BPS=25 npx tsx 01-passive-quoter.ts   # DRY_RUN
```
**Good for:** understanding the SSE feed and a first quote on chain.

### `02-inventory-aware-quoter.ts`
Tracks the master's balances, refuses to overexpose, widens spread as
inventory tilts. The skeleton you'd extend with your own pricing model.

```bash
MASTER_ADDRESS=0x... PAIR=SUPRA/USDC BASE_SPREAD_BPS=15 MAX_INVENTORY_PCT=80 \
npx tsx 02-inventory-aware-quoter.ts   # DRY_RUN
```

### `03-counter-arb-taker.ts`
The taker round-trip: submit an RFQ, watch for quotes, accept any with
edge ≥ threshold, time out and cancel after 5 min. Point it at buying
SUPRA cheap by setting `BUY_TOKEN=SUPRA`.

```bash
PAIR=USDC/SUPRA SELL_TOKEN=USDC BUY_TOKEN=SUPRA \
SELL_CHAIN=eth-mainnet BUY_CHAIN=supra-mainnet \
SIZE=2 REFERENCE_RATE=4054 MIN_EDGE_BPS=20 \
npx tsx 03-counter-arb-taker.ts   # DRY_RUN
```

---

## Cost & safety

Every accepted trade settles real assets. These examples have no size
limits beyond the delegate's on-chain caps — keep those **conservative**
while testing:
- `max_trade_size`: a small dollar value
- `max_earmark_total`: a small dollar value (your real overspend backstop)
- `expires_at_batch`: ~24h of batches (≈ `86_400`)

Loosen once you've watched the agent behave for a few hours.

## Where to take it next

A production agent likely adds: a pricing model (vol-adjusted spread,
dynamic skew), risk limits (max open RFQs, position-stop), a
reconciliation loop (re-fetch sequence on backoff), health monitoring
(`/api/council/current-batch` advancing, delegate still active), and
quote refresh/withdraw on stale price. The `DelegateSigner` handles
seq-number plumbing; everything else is your strategy.
