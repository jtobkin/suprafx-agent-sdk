/**
 * suprafx-agent-sdk — public API surface.
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

export { SupraFxClient, SupraFxError } from "./client.js";
export type {
  SupraFxClientOptions,
  ChainInfo,
  AssetInfo,
  PlatformBalance,
  OrderbookRfq,
  SubmitResult,
  OracleQuote,
  SupraFxErrorCode,
  SupraFxErrorAction,
} from "./client.js";

// Commit lifecycle: `ok` is an ingress signal, `lifecycle` is the truth.
export {
  withLifecycle,
  sameId,
  findRfq,
  findQuote,
  applyPollMs,
  DEFAULT_APPLY_POLL_MS,
} from "./mcp/lifecycle.js";
export type { CommitState, CommitResult } from "./mcp/lifecycle.js";

// Session preflight, reusable outside the MCP server.
export { runPreflight, ORACLE_STALE_MS } from "./mcp/preflight.js";
export type { PreflightResult, Check, CheckStatus } from "./mcp/preflight.js";

export { DelegateSigner } from "./signer.js";
export type { DelegateSignerOptions } from "./signer.js";

// Re-export BCS + derivation utilities so power users can compose
// custom flows without re-vendoring the council libs.
export { encodeUserEvent, MAX_CAP } from "./event-bcs.js";
export type { UserEvent, AssetCapEntry } from "./event-bcs.js";
export { composeSignBytes, encodeEnvelopeBcs } from "./sign-event.js";
export {
  canonicalChain,
  deriveAssetId,
  derivePairId,
  derivePairIdFromTokens,
  registeredAssetId,
  assetIdFromChainAndToken,
} from "./derive-ids.js";
export { toMicroUnits, toRateBFT } from "./asset-registry.js";
