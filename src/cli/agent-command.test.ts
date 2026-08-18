import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectHarnesses,
  mcpRegistered,
  registerMcp,
  getAgentStatus,
  runAgentInitCommand,
  runAgentStatusCommand,
  runAgentCommand,
  installSkills,
  type CommandRunner,
  type CommandResult,
} from "./agent-command.js";

// A scriptable CommandRunner: maps "cmd arg1 arg2" -> a canned result, and
// records every invocation so tests can assert exact argv (e.g. the real
// confirmed `claude mcp add --scope user heimdall -- heimdall mcp` /
// `codex mcp add heimdall -- heimdall mcp` syntax) without ever spawning a
// real process.
function fakeRunner(responses: Record<string, CommandResult>): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = {
    run(cmd: string, args: string[]): CommandResult {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      return responses[key] ?? { status: 127, stdout: "", stderr: `no fake response for: ${key}` };
    },
  };
  return { runner, calls };
}

function ok(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(status = 1, stderr = "error"): CommandResult {
  return { status, stdout: "", stderr };
}

test("detectHarnesses reports only harnesses found via `which`", () => {
  const { runner } = fakeRunner({
    "which claude": ok("/usr/local/bin/claude"),
    "which codex": fail(1),
  });
  assert.deepEqual(detectHarnesses(runner), ["claude"]);
});

test("detectHarnesses reports both when both are on PATH", () => {
  const { runner } = fakeRunner({
    "which claude": ok("/a/claude"),
    "which codex": ok("/a/codex"),
  });
  assert.deepEqual(detectHarnesses(runner), ["claude", "codex"]);
});

test("detectHarnesses reports neither when neither is on PATH", () => {
  const { runner } = fakeRunner({
    "which claude": fail(1),
    "which codex": fail(1),
  });
  assert.deepEqual(detectHarnesses(runner), []);
});

test("mcpRegistered uses the targeted `claude mcp get heimdall`, not `claude mcp list`", () => {
  const { runner, calls } = fakeRunner({
    "claude mcp get heimdall": ok("heimdall: heimdall mcp"),
  });
  assert.equal(mcpRegistered("claude", runner), true);
  assert.deepEqual(calls, ["claude mcp get heimdall"]);
});

test("mcpRegistered returns false for claude when `mcp get` exits non-zero", () => {
  const { runner } = fakeRunner({
    "claude mcp get heimdall": fail(1, 'No MCP server named "heimdall"'),
  });
  assert.equal(mcpRegistered("claude", runner), false);
});

test("mcpRegistered falls back to `codex mcp list` and checks the name column", () => {
  const { runner, calls } = fakeRunner({
    "codex mcp list": ok("Name      Command   Args\nheimdall  heimdall  mcp\nother     other     x\n"),
  });
  assert.equal(mcpRegistered("codex", runner), true);
  assert.deepEqual(calls, ["codex mcp list"]);
});

test("mcpRegistered for codex does not false-positive on a substring match", () => {
  const { runner } = fakeRunner({
    "codex mcp list": ok("Name          Command\nnot-heimdall  x\n"),
  });
  assert.equal(mcpRegistered("codex", runner), false);
});

test("mcpRegistered returns false for codex when `mcp list` itself fails", () => {
  const { runner } = fakeRunner({
    "codex mcp list": fail(1),
  });
  assert.equal(mcpRegistered("codex", runner), false);
});

test("registerMcp shells to the real confirmed claude syntax when not yet registered", () => {
  const { runner, calls } = fakeRunner({
    "claude mcp get heimdall": fail(1),
    "claude mcp add --scope user heimdall -- heimdall mcp": ok(),
  });
  const result = registerMcp("claude", runner);
  assert.equal(result.status, "registered");
  assert.deepEqual(calls, ["claude mcp get heimdall", "claude mcp add --scope user heimdall -- heimdall mcp"]);
});

test("registerMcp shells to the real confirmed codex syntax when not yet registered", () => {
  const { runner, calls } = fakeRunner({
    "codex mcp list": ok("Name\n"),
    "codex mcp add heimdall -- heimdall mcp": ok(),
  });
  const result = registerMcp("codex", runner);
  assert.equal(result.status, "registered");
  assert.deepEqual(calls, ["codex mcp list", "codex mcp add heimdall -- heimdall mcp"]);
});

test("registerMcp is idempotent: skips `mcp add` entirely when already registered", () => {
  const { runner, calls } = fakeRunner({
    "claude mcp get heimdall": ok("heimdall: heimdall mcp"),
  });
  const result = registerMcp("claude", runner);
  assert.equal(result.status, "already-registered");
  assert.deepEqual(calls, ["claude mcp get heimdall"]);
});

test("registerMcp surfaces real stderr on failure rather than swallowing it", () => {
  const { runner } = fakeRunner({
    "claude mcp get heimdall": fail(1),
    "claude mcp add --scope user heimdall -- heimdall mcp": fail(1, "permission denied"),
  });
  const result = registerMcp("claude", runner);
  assert.equal(result.status, "error");
  assert.equal(result.error, "permission denied");
});

test("getAgentStatus never calls `mcp add` (read-only)", () => {
  const { runner, calls } = fakeRunner({
    "which claude": ok(),
    "which codex": ok(),
    "claude mcp get heimdall": ok(),
    "codex mcp list": ok("Name\nheimdall  x\n"),
  });
  const statuses = getAgentStatus(["claude", "codex"], runner);
  assert.deepEqual(statuses, [
    { harness: "claude", installed: true, registered: true },
    { harness: "codex", installed: true, registered: true },
  ]);
  assert.ok(!calls.some((c) => c.includes("mcp add")));
});

test("getAgentStatus reports registered: false for a harness that isn't installed, without checking it", () => {
  const { runner, calls } = fakeRunner({
    "which claude": fail(1),
    "which codex": ok(),
    "codex mcp list": ok("Name\n"),
  });
  const statuses = getAgentStatus(["claude", "codex"], runner);
  assert.deepEqual(statuses[0], { harness: "claude", installed: false, registered: false });
  assert.ok(!calls.includes("claude mcp get heimdall"));
});

test("installSkills is a documented no-op for this story", () => {
  assert.deepEqual(installSkills(), { installed: [] });
});

test("runAgentInitCommand registers each installed harness and is silent about the rest", () => {
  const { runner, calls } = fakeRunner({
    "which claude": ok(),
    "which codex": fail(1),
    "claude mcp get heimdall": fail(1),
    "claude mcp add --scope user heimdall -- heimdall mcp": ok(),
  });

  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (msg: string) => logs.push(msg);
  try {
    runAgentInitCommand([], runner);
  } finally {
    console.log = originalLog;
  }

  assert.ok(calls.includes("claude mcp add --scope user heimdall -- heimdall mcp"));
  assert.ok(!calls.some((c) => c.startsWith("codex")));
  assert.ok(logs.some((l) => l.includes("claude") && l.includes("registered")));
  assert.ok(logs.some((l) => l.includes("codex") && l.includes("not installed")));
});

test("runAgentInitCommand run twice is idempotent: second run issues no `mcp add`", () => {
  // First run: not yet registered.
  const responses: Record<string, CommandResult> = {
    "which claude": ok(),
    "which codex": fail(1),
    "claude mcp get heimdall": fail(1),
    "claude mcp add --scope user heimdall -- heimdall mcp": ok(),
  };
  const { runner: firstRunner, calls: firstCalls } = fakeRunner(responses);

  const originalLog = console.log;
  console.log = () => {};
  try {
    runAgentInitCommand([], firstRunner);
  } finally {
    console.log = originalLog;
  }
  assert.ok(firstCalls.includes("claude mcp add --scope user heimdall -- heimdall mcp"));

  // Second run: now already registered — `claude mcp get` succeeds.
  const { runner: secondRunner, calls: secondCalls } = fakeRunner({
    "which claude": ok(),
    "which codex": fail(1),
    "claude mcp get heimdall": ok("heimdall: heimdall mcp"),
  });

  console.log = () => {};
  try {
    runAgentInitCommand([], secondRunner);
  } finally {
    console.log = originalLog;
  }

  assert.ok(!secondCalls.some((c) => c.includes("mcp add")));
});

test("runAgentInitCommand respects repeatable --harness to narrow scope", () => {
  const { runner, calls } = fakeRunner({
    "which claude": ok(),
    "which codex": ok(),
    "claude mcp get heimdall": ok(),
  });

  const originalLog = console.log;
  console.log = () => {};
  try {
    runAgentInitCommand(["--harness", "claude"], runner);
  } finally {
    console.log = originalLog;
  }

  assert.ok(calls.includes("claude mcp get heimdall"));
  // detectHarnesses always probes `which` for both, but --harness claude
  // must narrow which harness actually gets acted on — no codex `mcp`
  // subcommand should ever run.
  assert.ok(!calls.some((c) => c.startsWith("codex mcp")));
});

test("runAgentStatusCommand does not mutate: never calls `mcp add`", () => {
  const { runner, calls } = fakeRunner({
    "which claude": ok(),
    "which codex": ok(),
    "claude mcp get heimdall": fail(1),
    "codex mcp list": ok("Name\n"),
  });

  const originalLog = console.log;
  console.log = () => {};
  try {
    runAgentStatusCommand([], runner);
  } finally {
    console.log = originalLog;
  }

  assert.ok(!calls.some((c) => c.includes("mcp add")));
});

test("runAgentStatusCommand --json emits accurate structured status", () => {
  const { runner } = fakeRunner({
    "which claude": ok(),
    "which codex": fail(1),
    "claude mcp get heimdall": ok(),
  });

  const originalLog = console.log;
  let output = "";
  console.log = (msg: string) => {
    output += msg;
  };
  try {
    runAgentStatusCommand(["--json"], runner);
  } finally {
    console.log = originalLog;
  }

  const parsed = JSON.parse(output);
  assert.deepEqual(parsed, [
    { harness: "claude", installed: true, registered: true },
    { harness: "codex", installed: false, registered: false },
  ]);
});

test("runAgentCommand dispatches init/status and rejects unknown subcommands", () => {
  const { runner } = fakeRunner({
    "which claude": fail(1),
    "which codex": fail(1),
  });

  const originalLog = console.log;
  const originalError = console.error;
  let output = "";
  console.log = (msg: string) => {
    output += msg;
  };
  console.error = () => {};
  try {
    runAgentCommand(["status", "--json"], runner);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(JSON.parse(output), [
    { harness: "claude", installed: false, registered: false },
    { harness: "codex", installed: false, registered: false },
  ]);

  let exitCode: number | undefined;
  const originalExit = process.exit;
  // @ts-expect-error narrowing process.exit for the test
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error("exit");
  };
  console.error = () => {};
  try {
    runAgentCommand(["bogus"], runner);
  } catch {
    // expected: our stubbed process.exit throws to halt execution
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  assert.equal(exitCode, 1);
});
