#!/usr/bin/env bash
#
# Persistent launcher for the bullish SUPRA accumulator (cookbook/05).
#
# - Loads the delegate private key from ~/.suprafx/delegate.json (never printed).
# - Sources optional overrides from ~/.suprafx/accumulator.env
#   (MASTER_ADDRESS, QUOTE_ASSETS, MAX_PREMIUM_BPS, LIVE).
# - Defaults to DRY_RUN. It only trades for real if you set LIVE=1
#   (in the env file or the environment). That is your go-live switch.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Optional local config (gitignored). Keep MASTER_ADDRESS and LIVE here.
if [ -f "$HOME/.suprafx/accumulator.env" ]; then
  set -a; . "$HOME/.suprafx/accumulator.env"; set +a
fi

# Delegate key — read from the locked-down file, never echoed.
if [ ! -f "$HOME/.suprafx/delegate.json" ]; then
  echo "missing ~/.suprafx/delegate.json — run cookbook/00-generate-delegate-key.ts first" >&2
  exit 1
fi
export SUPRAFX_DELEGATE_PRIV_HEX="$(jq -r .privateKey "$HOME/.suprafx/delegate.json")"

: "${MASTER_ADDRESS:?set MASTER_ADDRESS in ~/.suprafx/accumulator.env}"
export MASTER_ADDRESS
export QUOTE_ASSETS="${QUOTE_ASSETS:-USDC,USDT,ETH}"
export MAX_PREMIUM_BPS="${MAX_PREMIUM_BPS:-25}"
# NOTE: LIVE is intentionally NOT defaulted on. Unset => DRY_RUN.

echo "[deploy] starting accumulator (LIVE=${LIVE:-<unset → DRY_RUN>}) pairs from QUOTE_ASSETS=$QUOTE_ASSETS premium=${MAX_PREMIUM_BPS}bps"
exec npx tsx cookbook/05-bullish-supra-accumulator.ts
