/**
 * One-off: cancel all of our master's currently-open RFQs, so the seeder
 * re-posts them fresh (e.g. after a size change). Run with the SEEDER STOPPED
 * to avoid two processes racing the delegate sequence number.
 *
 *   MASTER_ADDRESS=0x... npx tsx scripts/cancel-my-rfqs.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SupraFxClient, DelegateSigner } from "../src/index.js";

const BASE = process.env.SUPRAFX_BASE_URL ?? "https://suprafx.ai";
const MASTER = (process.env.MASTER_ADDRESS ?? "").toLowerCase();
if (!MASTER) {
  console.error("MASTER_ADDRESS required");
  process.exit(1);
}

const key = JSON.parse(readFileSync(join(homedir(), ".suprafx", "delegate.json"), "utf8"));
const client = new SupraFxClient({ baseUrl: BASE });
const signer = new DelegateSigner({ delegatePrivKeyHex: key.privateKey, client });

function uuidToBytes16(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function main() {
  await signer.loadSequenceFromChain();
  const r = await fetch(`${BASE}/api/suprafx/rfqs?scope=platform&status=open&limit=200`);
  const j = (await r.json()) as { data?: any[] };
  const mine = (j.data ?? []).filter(
    (x) => String(x.taker_address ?? "").toLowerCase() === MASTER,
  );
  console.log(`[cancel] ${mine.length} open RFQs to cancel for ${MASTER.slice(0, 10)}…`);
  let ok = 0;
  for (const rfq of mine) {
    const id = String(rfq.id);
    try {
      const c = await signer.cancelRfq({ rfq_id: uuidToBytes16(id), reason: "resize" });
      if (c.ok) {
        ok++;
        console.log(`  ✓ ${rfq.pair} ${id.slice(0, 8)}`);
      } else {
        console.log(`  ✗ ${rfq.pair} ${id.slice(0, 8)}: ${c.code}: ${c.detail}`);
      }
    } catch (e) {
      console.log(`  err ${id.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  console.log(`[cancel] done — ${ok}/${mine.length} cancelled`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
