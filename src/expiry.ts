/** Chain expiry bounds shared by every SDK signing surface. */
export const MIN_EXPIRY_LEAD_BATCHES = 2;
export const WEBSITE_EXPIRY_BUFFER_BATCHES = 10;
export const MIN_SAFE_EXPIRY_BATCHES =
  MIN_EXPIRY_LEAD_BATCHES + WEBSITE_EXPIRY_BUFFER_BATCHES;
export const DEFAULT_EXPIRY_BATCHES = 545;
export const MAX_EXPIRY_BATCHES = 200_000;

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
