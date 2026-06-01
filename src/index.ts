/**
 * @suprafx/agent-sdk — public API surface.
 *
 * Two main entry points:
 *   - `SupraFxClient` for read endpoints + envelope POST plumbing
 *   - `DelegateSigner` for held-key signing + auto sequence management
 *
 * Plus convenience re-exports of the BCS encoders and derivation
 * helpers so consumers can build custom envelopes if needed.
 *
 * See `docs/INTEGRATING-AGENTS.md` for the conceptual reference and
 * `cookbook/` for runnable examples.
 */

export { SupraFxClient } from "./client.js";
export type {
  SupraFxClientOptions,
  ChainInfo,
  AssetInfo,
  PlatformBalance,
  OrderbookRfq,
  SubmitResult,
} from "./client.js";

export { DelegateSigner } from "./signer.js";
export type { DelegateSignerOptions } from "./signer.js";

// Re-export BCS + derivation utilities so power users can compose
// custom flows without re-vendoring the council libs.
export { encodeUserEvent } from "./event-bcs.js";
export type { UserEvent } from "./event-bcs.js";
export { composeSignBytes, encodeEnvelopeBcs } from "./sign-event.js";
export {
  deriveAssetId,
  derivePairId,
  derivePairIdFromTokens,
  registeredAssetId,
  assetIdFromChainAndToken,
} from "./derive-ids.js";
export { toMicroUnits, toRateBFT } from "./asset-registry.js";
