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

import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runMCPServer } from "../src/mcp/server.js";
import { loadConfig } from "../src/mcp/config.js";

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
    console.log("@suprafx/agent-sdk 0.1.0");
    return;
  }
  const cfg = loadConfig();
  if (!cfg.delegatePrivKeyHex) {
    process.stderr.write(
      "[suprafx-mcp] no delegate key configured. Running in READ-ONLY mode.\n" +
        "[suprafx-mcp] To enable trading tools, run: `suprafx-mcp init`\n",
    );
  }
  await runMCPServer({
    baseUrl: cfg.baseUrl,
    delegatePrivKeyHex: cfg.delegatePrivKeyHex,
  });
}

function printHelp() {
  console.log(`
suprafx-mcp — Model Context Protocol server for SupraFX

Usage:
  suprafx-mcp            Run the MCP server over stdio (default for Claude Desktop)
  suprafx-mcp init       Interactive setup wizard — writes ~/.suprafx/config.json
  suprafx-mcp --help     Show this help

Environment overrides:
  SUPRAFX_DELEGATE_PRIV_HEX   Hex of delegate ed25519 private key (32 bytes)
  SUPRAFX_BASE_URL            Override the dApp base URL (default https://suprafx.ai)

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

  const baseUrl = await ask(
    "SupraFX base URL (press enter for https://suprafx.ai): ",
  );
  rl.close();

  const cfg: { delegatePrivKeyHex: string; baseUrl?: string } = {
    delegatePrivKeyHex: privHex,
  };
  if (baseUrl.length > 0) cfg.baseUrl = baseUrl;

  const cfgDir = join(homedir(), ".suprafx");
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  chmodSync(cfgPath, 0o600);

  console.log(`\n✓ Saved to ${cfgPath} (mode 600 — owner read/write only)`);
  console.log("");
  console.log("Next: add this to your Claude Desktop config:");
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
  console.log("Restart Claude Desktop. SupraFX tools will appear in the tool palette.");
  console.log("");
}

main().catch((e) => {
  process.stderr.write(
    `[suprafx-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
