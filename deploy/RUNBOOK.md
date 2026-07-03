# Live-ops runbook — running the accumulator in production

Day-to-day operation of a live agent: watch it, adjust it, and stop it
safely. Assumes the pm2 setup in [`README.md`](./README.md).

## Watch it

```bash
npx pm2 status                       # is it online? restart count (↺)?
npx pm2 logs supra-accumulator       # live output
npx pm2 logs supra-accumulator --lines 100 --nostream   # recent history
```

What the log lines mean:
- `✓ bid to buy N SUPRA for X USDC …` — a real quote landed on the book.
- `↩ withdrew stale bid on … (age Ns)` — an unmatched bid past
  `QUOTE_TTL_MS` was pulled so it wouldn't sit at a stale price.
- `rejected … gate_rejected: …` — the delegate policy blocked it; read
  the `detail` (see Troubleshooting).
- `📊 session: +N SUPRA accumulated; spent X USDC, … ; open bids K` —
  running totals since the process last started (from real balances).

Check position/fills independently (source of truth = the chain):
```bash
M=0xYOUR_MASTER
curl -s "https://suprafx.ai/api/platform/balances?address=$M" \
  | jq -r '.balances[] | "\(.asset): \(.available) avail, \(.locked_in_orders) in open quotes"'
```
`locked_in_orders` is funds tied up in your live bids.

## Adjust it

All knobs live in `~/.suprafx/accumulator.env`. Edit, then restart:
```bash
#  e.g. cap spend, widen/tighten premium, slow the poll:
#  MAX_SPEND_USDC=50   MAX_SPEND_USDT=50   MAX_PREMIUM_BPS=0   POLL_MS=3000
npx pm2 restart supra-accumulator
```
- `MAX_PREMIUM_BPS=0` → only buy at/below oracle. Negative (e.g. `-50`)
  → only buy 0.5% under oracle (patient).
- `MAX_SPEND_<ASSET>` → soft session cap (resets on restart). The
  **delegate earmark cap on chain is the hard limit** — set it too.

## Stop it — two levels

**Soft stop (pause quoting):**
```bash
npx pm2 stop supra-accumulator
```
Note: this does not withdraw bids already resting on the book — they
stay until matched or they expire. To pull them, let it run one more
TTL cycle first, or cancel from the dApp.

**Hard stop / kill switch (revoke authority entirely):**
On suprafx.ai → Profile → Delegates → **Deactivate**. One master
signature; every subsequent envelope from the delegate is rejected
within ~2 seconds. This is the real emergency brake — it works even if
the bot process is misbehaving or unreachable.

Then remove the process if you're done:
```bash
npx pm2 delete supra-accumulator
```

## Troubleshooting `gate_rejected`

| `detail` mentions | Cause | Fix |
|---|---|---|
| balance / insufficient | not enough of the asset you pay | fund it, or it self-skips |
| exceeds delegate max | trade over `max_trade_size` | raise cap, or lower size |
| earmark / cumulative | hit the delegate earmark cap | raise cap (hard limit) |
| asset not allowed | that quote asset's cap is disabled (deny-default) | enable it in Delegates |
| expired | delegate policy past its expiry batch | create a fresh delegate |
| rate_limited | >~1 write/sec | raise `POLL_MS` / `QUOTE_TTL_MS` |
| auth / sequence | key or seq mismatch | restart re-aligns the sequence |

## Keep it alive

- Machine must stay awake — see the caffeinate note in
  [`README.md`](./README.md). For true 24/7, move these files to a VPS.
- `npx pm2 save` after any start/stop so `pm2 startup` restores the
  right set on reboot.
