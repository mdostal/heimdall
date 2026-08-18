// CLI surface for hdl-ao-03 — `heimdall agent init` / `heimdall agent
// status`, mirroring Portunus's real agent_setup.py shape (confirmed
// against its current code, not guessed) and route-command.ts's style of
// a thin, unit-testable command module backing cli.ts's dispatcher.
//
// All shell-outs go through an injectable CommandRunner so unit tests can
// assert exact argv without ever spawning a real process — live
// verification against this machine's real `claude`/`codex` binaries is a
// deliberate separate step (see hdl-ao-03 story notes), not something the
// unit suite re-does on every run.

import { spawnSync } from "node:child_process";

export type Harness = "claude" | "codex";

export const ALL_HARNESSES: readonly Harness[] = ["claude", "codex"];

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(cmd: string, args: string[]): CommandResult;
}

// Real process-spawning runner. spawnSync (not exec/execSync) so args are
// passed as an argv array, never shell-interpolated — no quoting hazards
// around the `--` separator these commands rely on.
export const defaultRunner: CommandRunner = {
  run(cmd: string, args: string[]): CommandResult {
    const result = spawnSync(cmd, args, { encoding: "utf8" });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

// detectHarnesses: `which claude`/`which codex` — same mechanism
// Portunus's agent_setup.py uses to decide what's actually installed on
// this machine before attempting anything.
export function detectHarnesses(runner: CommandRunner = defaultRunner): Harness[] {
  return ALL_HARNESSES.filter((harness) => runner.run("which", [harness]).status === 0);
}

// mcpRegistered: the targeted, fast check. For Claude this is `claude mcp
// get heimdall` — NOT `claude mcp list`, which health-checks every
// registered server on the machine and is slow (30+s on a machine with
// many servers configured). This is the exact bug Portunus's own
// agent_setup.py already found and fixed; hdl-ao-03 must not reintroduce
// it. Codex has no per-server `get` equivalent, so it falls back to
// `codex mcp list` and checks whether `heimdall` appears as a registered
// server name (first column of the table, not a substring match anywhere
// in the output).
export function mcpRegistered(harness: Harness, runner: CommandRunner = defaultRunner): boolean {
  if (harness === "claude") {
    return runner.run("claude", ["mcp", "get", "heimdall"]).status === 0;
  }

  const result = runner.run("codex", ["mcp", "list"]);
  if (result.status !== 0) return false;
  return /^heimdall\s/m.test(result.stdout);
}

export type RegisterStatus = "registered" | "already-registered" | "error";

export interface RegisterResult {
  harness: Harness;
  status: RegisterStatus;
  error?: string;
}

// registerMcp: shells to the real confirmed current syntax. Checks
// mcpRegistered() first so a second `heimdall agent init` run is a no-op
// rather than attempting (and possibly erroring or duplicating) a second
// `mcp add` — this is what makes `agent init` idempotent regardless of
// whether the underlying `claude`/`codex mcp add` itself would refuse a
// duplicate.
//
// Deliberately registers the bare `heimdall` command (not an absolute
// path to this repo's bin/heimdall.js) — that's what a real global
// install resolves to on PATH, and it's the invocation a registered MCP
// entry must still work with after this repo checkout is gone.
export function registerMcp(harness: Harness, runner: CommandRunner = defaultRunner): RegisterResult {
  if (mcpRegistered(harness, runner)) {
    return { harness, status: "already-registered" };
  }

  const args =
    harness === "claude"
      ? ["mcp", "add", "--scope", "user", "heimdall", "--", "heimdall", "mcp"]
      : ["mcp", "add", "heimdall", "--", "heimdall", "mcp"];

  const result = runner.run(harness, args);
  if (result.status === 0) {
    return { harness, status: "registered" };
  }
  return { harness, status: "error", error: (result.stderr || result.stdout).trim() };
}

// installSkills: intentionally a no-op stub for hdl-ao-03. The real
// SKILL.md content (heimdall-lanes/heimdall-routing/heimdall-models/
// heimdall-status under agent_skills/) lands in a later story
// (hdl-ao-04) — inventing placeholder skill content here is explicitly
// out of scope. This function exists now so agent-init's overall flow
// shape (detect -> register -> install skills) is final; it does nothing
// until agent_skills/ actually exists.
export function installSkills(): { installed: string[] } {
  return { installed: [] };
}

export interface AgentStatusEntry {
  harness: Harness;
  installed: boolean;
  registered: boolean;
}

// getAgentStatus: read-only — never calls registerMcp. Reports installed
// state (via detectHarnesses) and, only for installed harnesses,
// registration state (via mcpRegistered). Never mutates anything.
export function getAgentStatus(
  harnesses: readonly Harness[],
  runner: CommandRunner = defaultRunner,
): AgentStatusEntry[] {
  const installed = detectHarnesses(runner);
  return harnesses.map((harness) => ({
    harness,
    installed: installed.includes(harness),
    registered: installed.includes(harness) ? mcpRegistered(harness, runner) : false,
  }));
}

function parseHarnessFlags(args: string[]): Harness[] {
  const result: Harness[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value: string | undefined;
    if (arg === "--harness") {
      value = args[++i];
    } else if (arg.startsWith("--harness=")) {
      value = arg.split("=")[1];
    }
    if (value === "claude" || value === "codex") {
      result.push(value);
    }
  }
  return result;
}

function resolveTargets(args: string[]): Harness[] {
  const requested = parseHarnessFlags(args);
  return requested.length > 0 ? requested : [...ALL_HARNESSES];
}

// runAgentInitCommand: detect -> register (per targeted harness) ->
// install skills. Idempotent by construction (see registerMcp). Exits
// non-zero only on a genuine registration failure for an installed
// harness — a harness simply not being installed is reported, not an
// error.
export function runAgentInitCommand(args: string[], runner: CommandRunner = defaultRunner): void {
  const targets = resolveTargets(args);
  const installed = detectHarnesses(runner);

  let hadError = false;

  for (const harness of targets) {
    if (!installed.includes(harness)) {
      console.log(`${harness}: not installed (skipping)`);
      continue;
    }

    const result = registerMcp(harness, runner);
    if (result.status === "already-registered") {
      console.log(`${harness}: already registered`);
    } else if (result.status === "registered") {
      console.log(`${harness}: registered`);
    } else {
      hadError = true;
      console.error(`${harness}: failed to register — ${result.error}`);
    }
  }

  installSkills();

  if (hadError) {
    process.exit(1);
  }
}

// runAgentStatusCommand: read-only report. Never calls registerMcp.
export function runAgentStatusCommand(args: string[], runner: CommandRunner = defaultRunner): void {
  const targets = resolveTargets(args);
  const jsonMode = args.includes("--json");
  const statuses = getAgentStatus(targets, runner);

  if (jsonMode) {
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }

  for (const entry of statuses) {
    if (!entry.installed) {
      console.log(`${entry.harness}: not installed`);
    } else {
      console.log(`${entry.harness}: installed, mcp ${entry.registered ? "registered" : "not registered"}`);
    }
  }
}

// runAgentCommand: the "agent" branch's own sub-dispatch (init/status),
// invoked from cli.ts's top-level dispatcher.
export function runAgentCommand(args: string[], runner: CommandRunner = defaultRunner): void {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === "init") {
    runAgentInitCommand(rest, runner);
  } else if (sub === "status") {
    runAgentStatusCommand(rest, runner);
  } else {
    console.error("Usage: heimdall agent <init|status> [--harness claude|codex] [--json]");
    process.exit(1);
  }
}
