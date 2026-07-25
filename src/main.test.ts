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

function mockCommandRunner(): CommandRunner {
  return {
    run: async (_command: string, args: string[]) => {
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
}

function mockFetch(): typeof fetch {
  return (async (url: unknown) => {
    if (typeof url === "string" && url.includes("status.")) {
      return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
    }
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
  }) as typeof fetch;
}

test("composeService wires one MulticaAutopilotScheduler + one InProcessScheduler per configured lane", () => {
  const service = composeService({
    env: testEnv(),
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.equal(service.multicaSchedulers.length, 2);
  assert.equal(service.inProcessSchedulers.length, 2);
  assert.equal(service.pipelines.size, 2);

  service.stopAll();
});

test("a lane seeded as degraded gets engaged by its InProcessScheduler end-to-end", async () => {
  const service = composeService({
    env: testEnv(),
    commandRunner: mockCommandRunner(),
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
  const env = testEnv();
  env.HEIMDALL_LANE_3_ID = "some-new-provider-lane";
  env.HEIMDALL_LANE_3_PROVIDER = "gemini"; // not registered in PROVIDER_ADAPTERS yet
  env.HEIMDALL_LANE_3_CREDENTIAL_REF = "GEMINI_TOKEN";
  env.GEMINI_TOKEN = "fake";

  const service = composeService({
    env,
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  // Still wires the 2 known-provider lanes; the unknown-provider lane is skipped, not crashed.
  assert.equal(service.multicaSchedulers.length, 2);
  assert.equal(service.pipelines.size, 2);

  service.stopAll();
});

test("Multica actuation not configured — every lane falls back to StubControlAdapter (no crash)", () => {
  const service = composeService({
    env: testEnv(), // no MULTICA_BASE_URL/MULTICA_WORKSPACE_ID/MULTICA_PAT_TOKEN
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.equal(service.controlAdapters.size, 2);
  for (const adapter of service.controlAdapters.values()) {
    assert.equal(adapter.constructor.name, "StubControlAdapter");
  }

  service.stopAll();
});

test("a lane with a HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS mapping gets MulticaControlAdapter when Multica IS configured", () => {
  const env = testEnv();
  env.MULTICA_BASE_URL = "http://localhost:8090";
  env.MULTICA_WORKSPACE_ID = "workspace-test";
  env.MULTICA_PAT_TOKEN = "fake-pat";
  env.HEIMDALL_LANE_1_MULTICA_AGENT_IDS = "agent-a";

  const service = composeService({
    env,
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.equal(service.controlAdapters.get("claude@mathew.dostal")?.constructor.name, "MulticaControlAdapter");
  assert.equal(service.controlAdapters.get("codex")?.constructor.name, "StubControlAdapter");

  service.stopAll();
});

test("the shared status watcher calls reconcile() for every lane on each tick, not just on transitions", async () => {
  const service = composeService({
    env: testEnv(),
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
    statusWatcherIntervalMs: 10,
  });

  service.store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "down",
    reset_at: null,
    reason: "seeded for test",
    signal_source: "active_probe",
    observed_at: "2026-07-25T12:00:00.000Z",
  });

  const adapter = service.controlAdapters.get("claude@mathew.dostal")!;
  const reconcileCalls: string[] = [];
  const originalReconcile = adapter.reconcile.bind(adapter);
  adapter.reconcile = async (lane, status) => {
    reconcileCalls.push(status);
    return originalReconcile(lane, status);
  };

  // Same "down" status held steady across multiple ticks — no transition —
  // yet reconcile() must still fire every tick (retry-for-free semantics).
  await new Promise<void>((resolve) => setTimeout(resolve, 55));

  service.stopAll();
  assert.ok(reconcileCalls.length >= 3, `expected several reconcile() calls, got ${reconcileCalls.length}`);
  assert.ok(reconcileCalls.every((s) => s === "down"));
});

test("POST /lanes/:laneId/refresh works end-to-end against the composed service", async () => {
  const service = composeService({
    env: testEnv(),
    commandRunner: mockCommandRunner(),
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
