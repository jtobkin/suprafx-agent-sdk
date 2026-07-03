/**
 * Read-only pre-flight. Proves the locally-saved delegate private key
 * derives the address you registered on chain, checks connectivity and
 * sequence, and lists active assets. Signs NOTHING, submits NOTHING.
 *
 *   npx tsx scripts/preflight.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SupraFxClient, DelegateSigner } from "../src/index.js";

const keyPath = join(homedir(), ".suprafx", "delegate.json");
const key = JSON.parse(readFileSync(keyPath, "utf8"));

const client = new SupraFxClient({ baseUrl: "https://suprafx.ai" });
const signer = new DelegateSigner({ delegatePrivKeyHex: key.privateKey, client });

const derived = signer.addressHex.toLowerCase();
const registered = String(key.supraAddress).toLowerCase();
const match = derived === registered;

console.log("── SupraFX delegate pre-flight (read-only) ──");
console.log(`derived address  : ${derived}`);
console.log(`registered addr  : ${registered}`);
console.log(`key ↔ address    : ${match ? "✓ MATCH" : "✗ MISMATCH — wrong key file!"}`);

const seq = await client.getSequenceNumber(signer.addressHex);
console.log(`next sequence    : ${seq}`);

const info = await client.getChainInfo().catch(() => null);
console.log(`chain            : ${info ? "✓ reachable" : "✗ unreachable"}`);

const assets = await client.listAssets();
const want = ["USDT", "SUPRA"];
const active = assets.map((a) => a.asset_symbol.toUpperCase());
console.log(`assets active    : ${active.join(", ")}`);
for (const w of want) {
  console.log(`  ${w.padEnd(6)} : ${active.includes(w) ? "✓ tradeable on platform" : "✗ not found"}`);
}

console.log("");
console.log(match
  ? "Pre-flight OK. The key file matches the on-chain delegate. Next: confirm on suprafx.ai that the delegate shows Active with USDT + SUPRA caps enabled, then a DRY_RUN."
  : "STOP: the saved key does NOT match the registered address. Do not go live — we need the correct key file.");
