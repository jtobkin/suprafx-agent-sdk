# Cookbook — runnable agent examples

These are pasta-ready starting points. Each file is self-contained,
~150 lines, and runs against the live `suprafx.ai` chain.

## Prerequisites

1. A delegate keypair authorized on chain by your master StarKey.
   (See [`../README.md`](../README.md#2-authorize-a-delegate-one-time).)
2. At least one asset deposited under the master.
3. `npm install` in the parent `agent-sdk/` directory.

## Examples

### `01-passive-quoter.ts`

Simplest market maker. Subscribes to one pair on the SSE feed; for
every new RFQ, posts a quote at reference price minus a fixed spread
(in bps). No inventory tracking, no exit logic.

```bash
SUPRAFX_DELEGATE_PRIV_HEX=0x... \
PAIR=ETH/USDC \
SPREAD_BPS=10 \
npx tsx 01-passive-quoter.ts
```

**Good for:** kicking the tires; getting a first quote on chain;
understanding the SSE feed.

### `02-inventory-aware-quoter.ts`

Tracks the master's available base + quote balance. Refuses to quote
when the new lock would exceed `MAX_INVENTORY_PCT` of available
balance. Widens the spread as inventory tilts away from 50/50 value.

```bash
SUPRAFX_DELEGATE_PRIV_HEX=0x... \
MASTER_ADDRESS=0x... \
PAIR=ETH/USDC \
BASE_SPREAD_BPS=15 \
MAX_INVENTORY_PCT=80 \
npx tsx 02-inventory-aware-quoter.ts
```

**Good for:** a production-ish quoter; the skeleton you'd extend
with your own pricing model.

### `03-counter-arb-taker.ts`

Reverses the maker role: submits an RFQ as taker, watches for incoming
quotes, accepts any with edge ≥ a configurable threshold. Times out
and cancels after 5 minutes if nothing acceptable arrives.

```bash
SUPRAFX_DELEGATE_PRIV_HEX=0x... \
PAIR=ETH/USDC \
SELL_CHAIN=eth-mainnet SELL_TOKEN=ETH \
BUY_CHAIN=eth-mainnet  BUY_TOKEN=USDC \
SIZE=0.1 REFERENCE_RATE=2400 MIN_EDGE_BPS=20 \
npx tsx 03-counter-arb-taker.ts
```

**Good for:** demonstrating the full taker round-trip (Submit →
listen → Accept). Pair with `01-passive-quoter` to see end-to-end
matching.

## Cost considerations

Every accepted trade settles real assets. These examples have no
size limits beyond the delegate's on-chain caps — make sure those
caps are conservative while you're testing. Recommended starting
caps for first-time agents:
- `max_trade_size: 0.001` ETH (or equivalent dollar value)
- `max_earmark_total: 0.01` ETH
- `expires_at_batch`: ~24 hours of batches (≈ 86_400)

You can re-bootstrap with looser caps once you've watched the agent
behave for a few hours.

## Where to take it next

These cookbook examples are intentionally minimal. A real
production agent likely adds:

- A pricing model (volatility-adjusted spread, dynamic skew)
- Risk limits (max open RFQs, position-stop)
- Reconciliation loop (re-fetch sequence on backoff)
- Health monitoring (`/api/council/current-batch` advancing,
  delegate policy still active)
- Quote refresh / withdraw on stale price

The `DelegateSigner` class handles seq-number plumbing for you;
everything else is your strategy.
