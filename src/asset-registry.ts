/**
 * BFT `Amount` encoding math.
 *
 * The council-rust protocol denominates token amounts in `Amount`
 * (u128) using **native per-asset decimals** — an asset with `D`
 * on-chain decimals is carried at the `10^D` scale, exactly as the
 * token contract reports it. See the `council-amount-decimals`
 * decision and council-rust `chain::eth::u256_to_native_amount`.
 * Rates are scaled by `PRICE_SCALE = 10^18` (council-rust `fees.rs`).
 *
 * ## This module is pure math — it embeds NO asset table
 *
 * Every function takes explicit `decimals` values. Per-(chain, asset)
 * decimals are the single responsibility of the `supported_assets`
 * registry, verified against each token's on-chain `decimals()` by
 * `scripts/verify-asset-decimals.ts`. There is deliberately no symbol
 * table here to drift as assets land on new chains — e.g. USDT is 6
 * decimals on Ethereum but 18 on BNB Smart Chain.
 *
 * Sourcing decimals:
 *   - server: `getAssetDecimals(chain, symbol)` — `lib/council/asset-decimals.ts`
 *   - client: `clientAssetDecimals(chain, symbol)` — `lib/council/client-asset-decimals.ts`
 *     (both read the `supported_assets` registry; client via `GET /api/assets`)
 */

/** `rate` fixed-point exponent. council-rust `fees.rs` PRICE_SCALE = 10^18. */
const PRICE_SCALE_EXP = 18;

/** Upper bound on plausible token decimals — guards against bad registry data. */
const MAX_DECIMALS = 36;

/** bigint exponentiation (avoids `**` for older TS lib targets). */
function bigintPow(base: bigint, exp: number): bigint {
  if (exp < 0) throw new Error(`bigintPow: negative exponent ${exp}`);
  let result = BigInt(1);
  for (let i = 0; i < exp; i++) result *= base;
  return result;
}

function assertValidDecimals(decimals: number, label: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(
      `${label}: invalid decimals ${decimals} (expected integer 0..${MAX_DECIMALS})`,
    );
  }
}

/**
 * Convert a display-unit amount to a BFT `Amount` (u128) at the asset's
 * native scale: `displayAmount × 10^decimals`.
 *
 * `decimals` is the asset's on-chain decimal precision on its chain
 * (from `supported_assets`). High-decimal assets split through 10^9 to
 * stay within IEEE-754 safe-integer range.
 */
export function toMicroUnits(amountDisplay: number, decimals: number): bigint {
  assertValidDecimals(decimals, "toMicroUnits");
  if (!Number.isFinite(amountDisplay) || amountDisplay < 0) {
    throw new Error(`toMicroUnits: invalid amount ${amountDisplay}`);
  }
  if (decimals <= 15) {
    // 10^15 < 2^53 — exact in float.
    return BigInt(Math.round(amountDisplay * 10 ** decimals));
  }
  // Split at 9 to stay within safe float range (2^53 ≈ 9×10^15).
  const lower = BigInt(Math.round(amountDisplay * 1e9));
  return lower * bigintPow(BigInt(10), decimals - 9);
}

/**
 * Convert a display exchange rate (quote per base) to the BFT-scaled
 * `rate` (u128).
 *
 * Protocol definition (council-rust `fees.rs`):
 *   `rate / PRICE_SCALE = quote-micro-units per base-micro-unit`
 *
 * With native per-asset decimals on both legs:
 *   `rate_BFT = rateDisplay × 10^(18 + quoteDecimals − baseDecimals)`
 */
export function toRateBFT(
  rateDisplay: number,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  assertValidDecimals(baseDecimals, "toRateBFT base");
  assertValidDecimals(quoteDecimals, "toRateBFT quote");
  if (!Number.isFinite(rateDisplay) || rateDisplay < 0) {
    throw new Error(`toRateBFT: invalid rate ${rateDisplay}`);
  }
  const totalExp = PRICE_SCALE_EXP + quoteDecimals - baseDecimals;
  if (totalExp < 0) {
    // Quote asset has far fewer decimals than base — encoding here
    // would truncate sub-unit precision. Refuse rather than silently
    // lose money-precision; this is unreachable for realistic pairs.
    throw new Error(
      `toRateBFT: negative scale exponent ${totalExp} (baseDec ${baseDecimals}, quoteDec ${quoteDecimals})`,
    );
  }
  if (totalExp >= 9) {
    const lower = BigInt(Math.round(rateDisplay * 1e9));
    return lower * bigintPow(BigInt(10), totalExp - 9);
  }
  return BigInt(Math.round(rateDisplay * 10 ** totalExp));
}

/**
 * Parse a `"BASE/QUOTE"` pair string into its two uppercase symbols.
 * @throws if the format is invalid.
 */
export function parsePair(pair: string): { base: string; quote: string } {
  const parts = pair.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`parsePair: expected "BASE/QUOTE", got "${pair}"`);
  }
  return {
    base: parts[0].trim().toUpperCase(),
    quote: parts[1].trim().toUpperCase(),
  };
}

/**
 * Encode `PlaceQuote` amounts: `fill_size` in base-asset native
 * micro-units, `rate` BFT-scaled. Caller supplies the base/quote
 * decimals (from the `supported_assets` registry).
 */
export function encodePlaceQuoteAmounts(
  sizeDisplay: number,
  rateDisplay: number,
  baseDecimals: number,
  quoteDecimals: number,
): { fillSizeMicro: bigint; rateBFT: bigint } {
  return {
    fillSizeMicro: toMicroUnits(sizeDisplay, baseDecimals),
    rateBFT: toRateBFT(rateDisplay, baseDecimals, quoteDecimals),
  };
}
