import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { composeService } from "./main.js";
import type { CommandRunner } from "./core/scheduler/command-runner.js";

function testEnv(): NodeJS.ProcessEnv {
  return {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_PROVIDER: "claude",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
    CLAUDE_TOKEN: "sk-ant-fake",
    HEIMDALL_LANE_2_ID: "codex",
    HEIMDALL_LANE_2_PROVIDER: "codex",
    HEIMDALL_LANE_2_CREDENTIAL_REF: "CODEX_TOKEN",
    CODEX_TOKEN: "sk-fake",
    MULTICA_AUTOPILOT_AGENT: "dostal-dev",
    HEIMDALL_DB_PATH: ":memory:",
  };
}

function mockCommandRunner(): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run: async (_command: string, args: string[]) => {
      calls.push(args);
      const verb = args[1];
      if (verb === "list") return { stdout: JSON.stringify({ autopilots: [] }), stderr: "" };
      if (verb === "create")
        return {
          stdout: JSON.stringify({ autopilot: { id: "mock-id", title: "mock" } }),
          stderr: "",
        };
      if (verb === "get")
        return {
          stdout: JSON.stringify({ autopilot: { id: "mock-id", title: "mock" }, triggers: [] }),
          stderr: "",
        };
      return { stdout: "{}", stderr: "" };
    },
  };
  return { runner, calls };
}

function mockFetch(): typeof fetch {
  return (async (url: unknown) => {
    if (typeof url === "string" && url.includes("status.")) {
      return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
    }
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
  }) as typeof fetch;
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

test("composeService wires and starts one MulticaAutopilotScheduler + one InProcessScheduler per configured lane", async () => {
  const { runner, calls } = mockCommandRunner();
  const service = composeService({
    env: testEnv(),
    commandRunner: runner,
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.equal(service.multicaSchedulers.length, 2);
  assert.equal(service.inProcessSchedulers.length, 2);
  assert.equal(service.pipelines.size, 2);

  await eventually(() => {
    const createCalls = calls.filter((args) => args[0] === "autopilot" && args[1] === "create");
    assert.equal(createCalls.length, 2);
    assert.ok(createCalls.every((args) => args.includes("dostal-dev")));
  });

  service.stopAll();
});

test("a lane seeded as degraded gets engaged by its InProcessScheduler end-to-end", async () => {
  const { runner } = mockCommandRunner();
  const service = composeService({
    env: testEnv(),
    commandRunner: runner,
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  service.store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "degraded",
    reset_at: null,
    reason: "seeded for test",
    signal_source: "active_probe",
    observed_at: "2026-07-25T12:00:00.000Z",
  });

  await service.inProcessSchedulers[0].poll();

  // Fresh status recorded by the real refresh() call driven through the pipeline —
  // mockFetch returns healthy responses, so the lane should resolve to up.
  const current = service.store.getCurrentStatus("claude@mathew.dostal");
  assert.equal(current?.status, "up");

  service.stopAll();
});

test("unknown provider is skipped gracefully — no pipeline/scheduler crash for the whole service", () => {
  const { runner } = mockCommandRunner();
  const env = testEnv();
  env.HEIMDALL_LANE_3_ID = "some-new-provider-lane";
  env.HEIMDALL_LANE_3_PROVIDER = "gemini"; // not registered in PROVIDER_ADAPTERS yet
  env.HEIMDALL_LANE_3_CREDENTIAL_REF = "GEMINI_TOKEN";
  env.GEMINI_TOKEN = "fake";

  const service = composeService({
    env,
    commandRunner: runner,
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  // Still wires the 2 known-provider lanes; the unknown-provider lane is skipped, not crashed.
  assert.equal(service.multicaSchedulers.length, 2);
  assert.equal(service.pipelines.size, 2);

  service.stopAll();
});

test("POST /lanes/:laneId/refresh works end-to-end against the composed service", async () => {
  const { runner } = mockCommandRunner();
  const service = composeService({
    env: testEnv(),
    commandRunner: runner,
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  await new Promise<void>((resolve) => service.httpServer.listen(0, resolve));
  const { port } = service.httpServer.address() as AddressInfo;

  try {
    const res = await fetch(
      `http://localhost:${port}/lanes/${encodeURIComponent("claude@mathew.dostal")}/refresh`,
      { method: "POST" },
    );
    assert.equal(res.status, 200);

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    const lanes = await lanesRes.json();
    const claudeLane = lanes.find((l: { lane_id: string }) => l.lane_id === "claude@mathew.dostal");
    assert.equal(claudeLane.status, "up");
  } finally {
    service.stopAll();
  }
});
