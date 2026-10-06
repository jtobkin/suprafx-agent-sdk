/** Chain expiry bounds shared by every SDK signing surface. */
export const MIN_EXPIRY_LEAD_BATCHES = 2;
export const WEBSITE_EXPIRY_BUFFER_BATCHES = 10;
export const MIN_SAFE_EXPIRY_BATCHES =
  MIN_EXPIRY_LEAD_BATCHES + WEBSITE_EXPIRY_BUFFER_BATCHES;
/**
 * LEGACY default, in batches. It was "about 30 minutes" when batches took
 * ~3.3 s; since the fast-blocks roll (2026-10-06, ~0.6 s/batch) it is only
 * ~5 minutes. New orders use `resolveDefaultExpiryBatches` (about 30
 * MINUTES at the chain's live pace); this constant is the last-resort
 * fallback and stays exported for callers that pin it on purpose.
 */
export const DEFAULT_EXPIRY_BATCHES = 545;
export const MAX_EXPIRY_BATCHES = 200_000;

/** Default order lifetime in wall-clock time, whatever the block speed. */
export const TARGET_ORDER_LIFETIME_SECONDS = 30 * 60;

export interface ExpiryRecommendationReader {
  getRecommendedExpiry(): Promise<{
    use_v2: boolean;
    lifetime_batches?: number;
    seconds_per_batch?: number;
  }>;
}

export interface DefaultExpiry {
  batches: number;
  /** "venue" = the venue measured its block pace; "legacy" = fixed 545. */
  source: "venue" | "legacy";
  secondsPerBatch: number | null;
  /** Approximate lifetime in seconds when the pace is known. */
  approxSeconds: number | null;
}

/**
 * Default expiry for an order that names no `expires_in_batches`: the
 * venue's recommendation for ~30 minutes at the chain's measured pace
 * (`GET /api/council/submit-rfq` with no lifetime). Any failure, or a
 * value outside the chain's limits, falls back to the legacy 545.
 */
export async function resolveDefaultExpiryBatches(
  reader: ExpiryRecommendationReader,
): Promise<DefaultExpiry> {
  try {
    const rec = await reader.getRecommendedExpiry();
    const batches = Number(rec.lifetime_batches);
    if (
      rec.use_v2 &&
      Number.isInteger(batches) &&
      batches >= MIN_SAFE_EXPIRY_BATCHES &&
      batches <= MAX_EXPIRY_BATCHES
    ) {
      const pace = Number(rec.seconds_per_batch);
      const secondsPerBatch = Number.isFinite(pace) && pace > 0 ? pace : null;
      return {
        batches,
        source: "venue",
        secondsPerBatch,
        approxSeconds: secondsPerBatch === null ? null : Math.round(batches * secondsPerBatch),
      };
    }
  } catch {
    // fall through to the legacy constant
  }
  return { batches: DEFAULT_EXPIRY_BATCHES, source: "legacy", secondsPerBatch: null, approxSeconds: null };
}

/** Rust's disabled/unpinned activation sentinel. */
export const U64_MAX = 18_446_744_073_709_551_615n;

export interface LockReleaseReader {
  getConsensusParams(): Promise<{
    fleet_must_match: { lock_release_activation_batch: string | number };
  }>;
  getCurrentBatch(): Promise<number>;
}

export interface LockReleaseState {
  live: boolean;
  /** Batch the next submitted envelope would target, when reads succeeded. */
  targetBatch: bigint | null;
  /** Null means the consensus parameter could not be read or parsed. */
  activationBatch: bigint | null;
}

/**
 * Read the two chain values that select the wire version for a new order.
 * Unknown is deliberately V1: tags 36/37 are rejected before activation,
 * while the validators continue to accept the legacy tags on both sides.
 */
export async function readLockReleaseState(
  reader: LockReleaseReader,
): Promise<LockReleaseState> {
  try {
    const [params, currentBatch] = await Promise.all([
      reader.getConsensusParams(),
      reader.getCurrentBatch(),
    ]);
    const activationBatch = BigInt(
      params.fleet_must_match.lock_release_activation_batch,
    );
    if (!Number.isSafeInteger(currentBatch) || currentBatch < 0 || activationBatch < 0n) {
      return { live: false, targetBatch: null, activationBatch: null };
    }
    const targetBatch = BigInt(currentBatch) + 1n;
    return {
      live: activationBatch !== U64_MAX && targetBatch >= activationBatch,
      targetBatch,
      activationBatch,
    };
  } catch {
    return { live: false, targetBatch: null, activationBatch: null };
  }
}
