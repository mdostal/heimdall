#!/usr/bin/env node
// Cross-platform CLI shim. Deliberately NOT a shebang-flag entrypoint and
// NOT NODE_OPTIONS-based: npm's generated cmd-shim on Windows does not
// forward shebang flags at all, and NODE_OPTIONS leaks into any child
// process the CLI itself spawns. spawnSync against process.execPath is the
// only approach that behaves identically on macOS/Linux/Windows.
//
// tsconfig.json's rootDir: "." + outDir: "dist" preserves the src/ prefix
// in the compiled output, so the real entrypoints are dist/src/api/cli.js
// and dist/src/api/mcp-server.js, not bare dist/cli.js / dist/mcp-server.js.
//
// `heimdall mcp` is special-cased to the stdio MCP server entrypoint
// (mcp-server.ts speaks the MCP protocol over stdin/stdout and never
// returns) rather than cli.ts's one-shot argv dispatcher — this is the
// exact invocation (`heimdall mcp`) that `heimdall agent init` registers
// with Claude Code / Codex, so it has to actually start the MCP server.
// Every other verb goes to cli.ts's existing dispatcher (lanes/route/
// route-outcome).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = join(__dirname, "..", "dist", "src", "api");

const args = process.argv.slice(2);
const isMcp = args[0] === "mcp";
const targetPath = join(apiDir, isMcp ? "mcp-server.js" : "cli.js");
const forwardedArgs = isMcp ? args.slice(1) : args;

const result = spawnSync(process.execPath, [targetPath, ...forwardedArgs], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.signal ? 1 : (result.status ?? 0));
