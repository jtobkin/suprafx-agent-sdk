/**
 * 00 — Generate a delegate keypair locally (the more secure path).
 *
 * The private key is created on YOUR machine and never touches a
 * browser, a download folder, or the network. You paste only the
 * PUBLIC key + supra address into the suprafx.ai delegate form, sign
 * the policy with StarKey, and your bot signs with the private key
 * that stays here.
 *
 * Run:
 *   npx tsx cookbook/00-generate-delegate-key.ts
 *
 * Writes ~/.suprafx/delegate.json (mode 0600, refuses to overwrite
 * unless FORCE=1). The PRIVATE key is never printed to the terminal.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveSupraAddress } from "../src/sign-event.js";

const OUT_DIR = join(homedir(), ".suprafx");
const OUT_FILE = join(OUT_DIR, "delegate.json");

if (existsSync(OUT_FILE) && process.env.FORCE !== "1") {
  console.error(
    `Refusing to overwrite ${OUT_FILE}\n` +
      `A delegate key already exists there. Set FORCE=1 to replace it ` +
      `(only if you're sure you no longer need the old one).`,
  );
  process.exit(1);
}

const priv = ed25519.utils.randomPrivateKey(); // 32 secure random bytes
const pub = ed25519.getPublicKey(priv);
const address = deriveSupraAddress(pub);

const privHex = "0x" + bytesToHex(priv);
const pubHex = "0x" + bytesToHex(pub);
const addrHex = "0x" + bytesToHex(address);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      _warning:
        "PRIVATE KEY — never share, never commit, never paste into chat. This is the only copy.",
      createdAt: new Date().toISOString(),
      privateKey: privHex,
      publicKey: pubHex,
      supraAddress: addrHex,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
chmodSync(OUT_FILE, 0o600);

console.log("✓ Delegate keypair generated locally. Private key saved (NOT shown).");
console.log(`  file:  ${OUT_FILE}  (mode 0600)`);
console.log("");
console.log("── Paste THESE into the suprafx.ai delegate form (public — safe to share) ──");
console.log(`  Public key:    ${pubHex}`);
console.log(`  Supra address: ${addrHex}`);
console.log("");
console.log("After you sign the policy with StarKey, load the key for your bot:");
console.log(`  export SUPRAFX_DELEGATE_PRIV_HEX="$(jq -r .privateKey ${OUT_FILE})"`);
