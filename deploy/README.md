# Deploy — run an agent persistently

Keeps the bullish SUPRA accumulator (`cookbook/04`) running in the
background with auto-restart on crash, via [pm2](https://pm2.keymetrics.io/).

**Safety:** the launcher defaults to **DRY_RUN**. It only trades for
real when *you* set `LIVE=1` in `~/.suprafx/accumulator.env`. Starting
pm2 is not the same as going live — flipping `LIVE=1` is.

> **Use `npx pm2` — do NOT `npm install -g pm2`.** A global install
> writes to `/usr/local/lib` and fails with `EACCES` on most macOS
> setups. `npx pm2` needs no sudo and no global install; it caches pm2
> on first use. (The pm2 daemon it starts persists across your terminal
> sessions.)

## 1. One-time config (gitignored, on your machine)

Create `~/.suprafx/accumulator.env`:

```bash
MASTER_ADDRESS=0xYOUR_MASTER_STARKEY_ADDRESS
QUOTE_ASSETS=USDC,USDT,ETH
MAX_PREMIUM_BPS=25
# Optional safeguards:
# MAX_SPEND_USDC=50     # soft session spend cap per asset (delegate cap = hard limit)
# MAX_SPEND_USDT=50
# QUOTE_TTL_MS=30000    # withdraw unmatched bids older than this
# POLL_MS=2000          # orderbook poll cadence
# LIVE=1                # <-- uncomment ONLY when you're funded + caps enabled and ready to trade
```

The delegate key is read automatically from `~/.suprafx/delegate.json`
(mode 0600) — never put it in this file.

For day-to-day operation (watch, adjust, kill switch, troubleshooting),
see **[RUNBOOK.md](./RUNBOOK.md)**.

## 2. Start it (DRY_RUN)

```bash
npx pm2 start deploy/ecosystem.config.cjs
npx pm2 logs supra-accumulator        # watch "WOULD buy …" (dry) or "✓ bid to buy …" (live)
npx pm2 save                          # remember this process list
```

## 3. Go live

When you've funded the quote assets and enabled their delegate caps:

```bash
#  edit ~/.suprafx/accumulator.env → uncomment LIVE=1, then:
npx pm2 restart supra-accumulator
npx pm2 logs supra-accumulator        # now: "✓ bid to buy … SUPRA"
```

## 4. Survive reboot (optional)

```bash
npx pm2 save
npx pm2 startup        # run the sudo command it prints (one-time)
```

## macOS caveats (why a laptop isn't ideal for 24/7)

- pm2 keeps the agent alive while the Mac is **awake**, but it **pauses
  on sleep**. To keep quoting overnight, prevent sleep:
  `caffeinate -is npx pm2 logs supra-accumulator` (or System Settings →
  Battery → prevent sleep on power adapter).
- On reboot it only comes back if you ran `npx pm2 save` + `npx pm2 startup`.
- For genuinely continuous operation, run the same files on a small
  VPS / Railway / Fly instead — identical setup, just an always-on host.

## Stop / status

```bash
npx pm2 status
npx pm2 stop supra-accumulator
npx pm2 delete supra-accumulator
```
