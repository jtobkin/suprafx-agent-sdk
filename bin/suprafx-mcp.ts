#!/usr/bin/env node
/**
 * `suprafx-mcp` CLI entry point.
 *
 * Two modes:
 *   - `suprafx-mcp init` — interactive setup wizard. Writes
 *     `~/.suprafx/config.json` with the user's delegate priv key
 *     after they paste it in or point to a JSON file the dApp
 *     downloaded.
 *   - `suprafx-mcp` (no args) — runs the MCP server over stdio.
 *     Designed to be invoked by Claude Desktop / Cursor / Continue
 *     as a subprocess. Reads stdin for JSON-RPC, writes stdout for
 *     responses, stderr for log lines.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runMCPServer } from "../src/mcp/server.js";
import { loadConfig, resolveMode, resolveToolGroups } from "../src/mcp/config.js";

/** Read the real version from the installed package.json.
 *  A hard-coded string silently goes stale and then LIES about which
 *  build is running — exactly the thing `--version` exists to answer. */
function packageVersion(): string {
  try {
    const here = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(here, "utf-8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* fall through */
  }
  try {
    const here = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(here, "utf-8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* fall through */
  }
  return "unknown";
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "init") {
    await initWizard();
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(`@suprafx/agent-sdk ${packageVersion()}`);
    return;
  }
  const cfg = loadConfig();
  const mode = resolveMode();
  const groups = resolveToolGroups();
  if (!cfg.delegatePrivKeyHex) {
    process.stderr.write(
      "[suprafx-mcp] no delegate key configured. Running in READ-ONLY mode.\n" +
        "[suprafx-mcp] To enable trading tools, run: `suprafx-mcp init`\n",
    );
  } else if (mode === "autonomous") {
    process.stderr.write(
      "[suprafx-mcp] AUTONOMOUS mode: money tools will NOT ask for per-call\n" +
        "[suprafx-mcp] acknowledgement. Every write is real money.\n",
    );
  }
  if (!cfg.masterAddress) {
    process.stderr.write(
      "[suprafx-mcp] no master address set — balance, lock and open-order reads\n" +
        "[suprafx-mcp] need it. Set SUPRAFX_MASTER_ADDRESS or re-run `suprafx-mcp init`.\n",
    );
  }
  await runMCPServer({
    baseUrl: cfg.baseUrl,
    delegatePrivKeyHex: cfg.delegatePrivKeyHex,
    masterAddress: cfg.masterAddress,
    mode,
    groups,
  });
}

function printHelp() {
  console.log(`
suprafx-mcp — Model Context Protocol server for SupraFX

Usage:
  suprafx-mcp            Run the MCP server over stdio (default for Claude Desktop)
  suprafx-mcp init       Interactive setup wizard — writes ~/.suprafx/config.json
  suprafx-mcp --help     Show this help
  suprafx-mcp --version  Print the installed package version

Flags:
  --tools=read                Expose ONLY read tools, even with a key loaded
                              (a keyed monitor agent that cannot trade).
                              Also: --tools=read,cancel  (cancel-only)
                                    --tools=read,trade   (no cancel class)
                              Default: every class the key entitles you to.
  --allow-dangerous           AUTONOMOUS mode: money tools stop requiring a
                              per-call 'acknowledged:true'. Without this the
                              server is GUARDED — every write asks once.

Environment overrides:
  SUPRAFX_DELEGATE_PRIV_HEX   Hex of delegate ed25519 private key (32 bytes)
  SUPRAFX_MASTER_ADDRESS      Your MASTER StarKey address — balances, locks and
                              open orders all live there, not on the delegate
  SUPRAFX_BASE_URL            Override the dApp base URL (default https://suprafx.ai)
  SUPRAFX_ALLOW_DANGEROUS=1   Same as --allow-dangerous
  SUPRAFX_TOOLS=read,cancel   Same as --tools=

One-line install (Claude Code):

  npm install -g @suprafx/agent-sdk
  claude mcp add --scope user suprafx -- suprafx-mcp

Configure Claude Desktop by adding this to your claude_desktop_config.json:

{
  "mcpServers": {
    "suprafx": {
      "command": "suprafx-mcp"
    }
  }
}

Then restart Claude Desktop. Tools will appear in the model's tool palette.

Documentation: https://github.com/jtobkin/suprafx-agent-sdk
`);
}

async function initWizard() {
  console.log("\nSupraFX MCP setup wizard\n========================\n");
  console.log("Before you start, you need a delegate keypair authorized");
  console.log("on chain by your master StarKey wallet.");
  console.log("");
  console.log("If you haven't done that yet:");
  console.log("  1. Go to https://suprafx.ai");
  console.log("  2. Connect StarKey, open Profile → Delegates");
  console.log("  3. Click 'Create Delegate'");
  console.log("  4. Click 'Generate' — a JSON file downloads to your machine.");
  console.log("     KEEP THIS FILE SAFE. The private key inside controls trading.");
  console.log("  5. Set per-asset caps, sign the policy with StarKey.");
  console.log("");
  console.log("Now paste the 32-byte hex private key (or a path to the");
  console.log("downloaded JSON file). Press enter when done.");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, (a) => resolve(a.trim())));

  const input = await ask("Delegate private key (hex or path to JSON): ");
  let privHex: string;
  if (input.startsWith("/") || input.startsWith("~") || input.startsWith("./")) {
    const path = input.startsWith("~") ? join(homedir(), input.slice(1)) : input;
    if (!existsSync(path)) {
      throw new Error(`File not found: ${path}`);
    }
    const j = JSON.parse(readFileSync(path, "utf-8"));
    const key =
      j.delegatePrivKeyHex ?? j.privateKeyHex ?? j.privateKey ?? j.priv;
    if (!key) {
      throw new Error(
        `JSON at ${path} did not contain a recognized private-key field`,
      );
    }
    privHex = String(key);
  } else {
    privHex = input;
  }

  privHex = privHex.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(privHex)) {
    throw new Error(
      `Expected a 32-byte hex private key (64 hex chars). Got ${privHex.length} chars.`,
    );
  }

  console.log("");
  console.log("Now your MASTER StarKey address — the wallet you connected to");
  console.log("suprafx.ai with, that holds the funds. Your agent needs it to read");
  console.log("balances and locks; the delegate has no balances of its own.");
  console.log("Saving it here means the agent never has to be told it again.");
  console.log("");
  let masterAddress = await ask("Master StarKey address (0x…, or enter to skip): ");
  masterAddress = masterAddress.trim().toLowerCase();
  if (masterAddress.length > 0) {
    const m = masterAddress.startsWith("0x") ? masterAddress.slice(2) : masterAddress;
    if (!/^[0-9a-f]{64}$/.test(m)) {
      rl.close();
      throw new Error(
        `Expected a 32-byte hex address (64 hex chars, 0x-prefixed). Got ${m.length} chars.`,
      );
    }
    masterAddress = "0x" + m;
  }

  const baseUrl = await ask(
    "SupraFX base URL (press enter for https://suprafx.ai): ",
  );
  rl.close();

  const cfg: {
    delegatePrivKeyHex: string;
    baseUrl?: string;
    masterAddress?: string;
  } = { delegatePrivKeyHex: privHex };
  if (masterAddress.length > 0) cfg.masterAddress = masterAddress;
  if (baseUrl.length > 0) cfg.baseUrl = baseUrl;

  const cfgDir = join(homedir(), ".suprafx");
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.json");
  // Atomic write (temp + rename): a running suprafx-mcp hot-reloads this
  // file, so a truncate-then-write could be read mid-rotation as a partial
  // (invalid JSON) and flip the server to read-only. Write to a temp file
  // with 0600 first, then rename into place (atomic on the same filesystem).
  const tmpPath = `${cfgPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, cfgPath);

  console.log(`\n✓ Saved to ${cfgPath} (mode 600 — owner read/write only)`);
  console.log("");
  if (!cfg.masterAddress) {
    console.log("⚠ No master address saved. Balance and open-order reads will need");
    console.log("  one passed by hand every session. Re-run `suprafx-mcp init` to add it.");
    console.log("");
  }
  console.log("Next — Claude Code, one line:");
  console.log("");
  console.log("  claude mcp add --scope user suprafx -- suprafx-mcp");
  console.log("");
  console.log("Or add this to your Claude Desktop config:");
  console.log("");
  console.log("  ~/Library/Application Support/Claude/claude_desktop_config.json");
  console.log("");
  console.log(`  {
    "mcpServers": {
      "suprafx": {
        "command": "suprafx-mcp"
      }
    }
  }`);
  console.log("");
  console.log("Restart / reconnect. SupraFX tools will appear in the tool palette —");
  console.log("the key is read at STARTUP, so a running server will not see it until then.");
  console.log("");
  console.log("The server starts GUARDED: every money tool asks for an explicit");
  console.log("acknowledgement per call. For an unattended loop, launch it with");
  console.log("--allow-dangerous. For a monitor that must never trade: --tools=read.");
  console.log("");
}

main().catch((e) => {
  process.stderr.write(
    `[suprafx-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
