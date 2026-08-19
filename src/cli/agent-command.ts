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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// The 4 real usage skills (hdl-ao-04). Directory names double as both the
// source subdirectory under agent_skills/ AND the installed subdirectory
// under ~/.claude/skills/ — a direct 1:1 copy, no renaming in either
// direction.
export const SKILL_NAMES = ["heimdall-lanes", "heimdall-routing", "heimdall-models", "heimdall-status"] as const;

// resolvePackageRoot: walks up from a starting directory looking for the
// nearest package.json. Needed because this file's own on-disk location
// differs between dev (tsx runs src/cli/agent-command.ts directly, 2
// levels below repo root) and the packaged/compiled bin
// (tsconfig's rootDir: "." + outDir: "dist" preserves the src/ prefix, so
// the compiled file is dist/src/cli/agent-command.js, 3 levels below
// package root) — see bin/heimdall.js's own comment on this exact
// asymmetry. Walking up to the nearest package.json works identically in
// both shapes instead of hardcoding a level count that would silently
// break the moment either shape changes.
function resolvePackageRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`installSkills: could not locate heimdall's package root walking up from ${startDir}`);
}

// resolveAgentSkillsDir: the real on-disk agent_skills/ directory shipped
// alongside this package (repo root in a dev checkout; package root after
// a global npm install — package.json's "files" field includes
// agent_skills so it ships in the published tarball too).
export function resolveAgentSkillsDir(moduleUrl: string = import.meta.url): string {
  return join(resolvePackageRoot(dirname(fileURLToPath(moduleUrl))), "agent_skills");
}

export interface SkillInstallResult {
  /** Skill directory names actually written this run (missing, or content differed from source). */
  installed: string[];
  /** Skill directory names left untouched because installed content already matched source exactly. */
  upToDate: string[];
}

// installSkills: copies each agent_skills/{name}/SKILL.md to
// ~/.claude/skills/{name}/SKILL.md, content-diffed before overwrite —
// same idempotency contract as Portunus's own filecmp.cmp-based
// install_skills(). A destination file is only written when its current
// content differs from the source (or it doesn't exist yet); an unchanged
// destination is left alone entirely (no write, no mtime bump), so a
// repeated `heimdall agent init` with nothing changed is a true no-op
// here, while a source-content change (this package upgrading its own
// skill docs) still lands on the next run even if the operator never
// touched the installed copy themselves.
//
// homedir and skillsSourceDir are both injectable (mirrors registerMcp's
// injectable CommandRunner) so unit tests exercise this against real
// temp directories rather than the operator's actual $HOME/~/.claude.
export function installSkills(
  homedir: string = osHomedir(),
  skillsSourceDir: string = resolveAgentSkillsDir(),
): SkillInstallResult {
  const installed: string[] = [];
  const upToDate: string[] = [];

  for (const name of SKILL_NAMES) {
    const sourcePath = join(skillsSourceDir, name, "SKILL.md");
    if (!existsSync(sourcePath)) {
      // Shipped-with-package content missing (e.g. a broken install) —
      // skip rather than crash the rest of `agent init` over one skill.
      continue;
    }
    const sourceContent = readFileSync(sourcePath, "utf8");

    const destDir = join(homedir, ".claude", "skills", name);
    const destPath = join(destDir, "SKILL.md");
    const existingContent = existsSync(destPath) ? readFileSync(destPath, "utf8") : null;

    if (existingContent === sourceContent) {
      upToDate.push(name);
      continue;
    }

    mkdirSync(destDir, { recursive: true });
    writeFileSync(destPath, sourceContent, "utf8");
    installed.push(name);
  }

  return { installed, upToDate };
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
// install skills. Idempotent by construction (see registerMcp and
// installSkills). Exits non-zero only on a genuine registration failure
// for an installed harness — a harness simply not being installed is
// reported, not an error.
//
// skillsHomedir/skillsSourceDir are optional pass-throughs to
// installSkills, purely for unit-test injection (defaulting to `undefined`
// so production callers get installSkills' own real-machine defaults) —
// mirrors how `runner` is threaded through for the harness side.
export function runAgentInitCommand(
  args: string[],
  runner: CommandRunner = defaultRunner,
  skillsHomedir?: string,
  skillsSourceDir?: string,
): void {
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

  const skillsResult = installSkills(skillsHomedir, skillsSourceDir);
  for (const name of skillsResult.installed) {
    console.log(`skill ${name}: installed`);
  }
  for (const name of skillsResult.upToDate) {
    console.log(`skill ${name}: already up to date`);
  }

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
