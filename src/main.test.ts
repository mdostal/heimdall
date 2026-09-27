import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    if (typeof url === "string" && url.includes("incidents.json")) {
      // Gemini's public-status feed is a flat incident array, not a
      // StatusPage.io component snapshot — see signal-sources/public-status/gemini.ts.
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    if (typeof url === "string" && url.includes("status.")) {
      return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({}),
    } as unknown as Response;
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

test("PANT-753: without MULTICA_AUTOPILOT_AGENT, no autopilot is registered and every lane is still probed at startup (never left on the all-down fallback)", async () => {
  const env = testEnv();
  delete env.MULTICA_AUTOPILOT_AGENT;
  const commandCalls: string[][] = [];
  const service = composeService({
    env,
    commandRunner: {
      run: async (command: string, args: string[]) => {
        commandCalls.push([command, ...args]);
        return { stdout: "{}", stderr: "" };
      },
    },
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.equal(service.multicaSchedulers.length, 0, "autopilot scheduling is opt-in — no agent, no autopilot");
  assert.equal(service.inProcessSchedulers.length, 2);

  // The InProcessSchedulers' first poll fires at startup (initialDelayMs: 0),
  // not after the 5s interval — wait for both lanes' first real probe.
  const deadline = Date.now() + 2_000;
  const laneIds = ["claude@mathew.dostal", "codex"];
  while (Date.now() < deadline) {
    if (laneIds.every((id) => service.store.getCurrentStatus(id)?.signal_source === "active_probe")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  for (const id of laneIds) {
    const current = service.store.getCurrentStatus(id);
    assert.equal(current?.status, "up", `${id} should be probed up at startup, got ${current?.status} (${current?.reason})`);
  }
  assert.deepEqual(
    commandCalls.filter((c) => c[0] === "multica"),
    [],
    "no multica autopilot CLI calls — autopilot triggers dispatch LLM sessions and spend quota",
  );

  service.stopAll();
});

test("hdl-rr-04: a provider with only 1 credentialed lane gets no RotationController", () => {
  const service = composeService({
    env: testEnv(), // one claude lane, one codex lane — 1 each
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.equal(service.rotationControllers.size, 0);

  service.stopAll();
});

test("hdl-rr-04: a provider with 2+ credentialed lanes gets a RotationController, wired with a cap-reset job", () => {
  const service = composeService({
    env: {
      ...testEnv(),
      HEIMDALL_LANE_3_ID: "claude-b",
      HEIMDALL_LANE_3_PROVIDER: "claude",
      HEIMDALL_LANE_3_CREDENTIAL_REF: "CLAUDE_TOKEN_B",
      CLAUDE_TOKEN_B: "sk-ant-fake-b",
    },
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.deepEqual([...service.rotationControllers.keys()], ["claude"]);

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

test("a gemini-provider lane gets a real pipeline + schedulers wired up, resolving end-to-end", async () => {
  const env = testEnv();
  env.HEIMDALL_LANE_3_ID = "gemini@mathew.dostal";
  env.HEIMDALL_LANE_3_PROVIDER = "gemini";
  env.HEIMDALL_LANE_3_CREDENTIAL_REF = "GEMINI_TOKEN";
  env.GEMINI_TOKEN = "fake-gemini-key";

  const service = composeService({
    env,
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  // No "no ProviderAdapters registered" skip — gemini is a known provider now.
  assert.equal(service.multicaSchedulers.length, 3);
  assert.equal(service.inProcessSchedulers.length, 3);
  assert.equal(service.pipelines.size, 3);

  service.store.recordStatus({
    lane_id: "gemini@mathew.dostal",
    status: "degraded",
    reset_at: null,
    reason: "seeded for test",
    signal_source: "active_probe",
    observed_at: "2026-08-13T12:00:00.000Z",
  });

  const geminiSchedulerIndex = 2;
  await service.inProcessSchedulers[geminiSchedulerIndex].poll();

  // Fresh status recorded by the real refresh() call, driven through
  // probeGeminiLane/checkGeminiPublicStatus — not a stub.
  const current = service.store.getCurrentStatus("gemini@mathew.dostal");
  assert.equal(current?.status, "up");

  service.stopAll();
});

test("a kimi-provider lane gets a real pipeline + schedulers wired up, resolving end-to-end", async () => {
  const env = testEnv();
  env.HEIMDALL_LANE_3_ID = "kimi@mathew.dostal";
  env.HEIMDALL_LANE_3_PROVIDER = "kimi";
  env.HEIMDALL_LANE_3_CREDENTIAL_REF = "KIMI_TOKEN";
  env.KIMI_TOKEN = "fake-kimi-key";

  const service = composeService({
    env,
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.equal(service.multicaSchedulers.length, 3);
  assert.equal(service.inProcessSchedulers.length, 3);
  assert.equal(service.pipelines.size, 3);

  service.store.recordStatus({
    lane_id: "kimi@mathew.dostal",
    status: "degraded",
    reset_at: null,
    reason: "seeded for test",
    signal_source: "active_probe",
    observed_at: "2026-08-13T14:00:00.000Z",
  });

  const kimiSchedulerIndex = 2;
  await service.inProcessSchedulers[kimiSchedulerIndex].poll();

  // Fresh status recorded by the real refresh() call, driven through
  // probeKimiLane/checkKimiPublicStatus — not a stub.
  const current = service.store.getCurrentStatus("kimi@mathew.dostal");
  assert.equal(current?.status, "up");

  service.stopAll();
});

test("two openrouter lanes sharing one credential_ref nest independently — the gateway-with-routes proof", async () => {
  const env = testEnv();
  env.HEIMDALL_LANE_3_ID = "openrouter-kimi";
  env.HEIMDALL_LANE_3_PROVIDER = "openrouter";
  env.HEIMDALL_LANE_3_CREDENTIAL_REF = "OPENROUTER_TOKEN";
  env.HEIMDALL_LANE_3_MODEL = "moonshotai/kimi-k3";
  env.HEIMDALL_LANE_4_ID = "openrouter-grok";
  env.HEIMDALL_LANE_4_PROVIDER = "openrouter";
  env.HEIMDALL_LANE_4_CREDENTIAL_REF = "OPENROUTER_TOKEN"; // same credential — one gateway, two routes
  env.HEIMDALL_LANE_4_MODEL = "x-ai/grok-4";
  env.OPENROUTER_TOKEN = "fake-openrouter-key";

  const service = composeService({
    env,
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  // Both routes get fully independent pipelines/schedulers despite sharing one credential.
  assert.equal(service.multicaSchedulers.length, 4);
  assert.equal(service.inProcessSchedulers.length, 4);
  assert.equal(service.pipelines.size, 4);
  assert.ok(service.pipelines.has("openrouter-kimi"));
  assert.ok(service.pipelines.has("openrouter-grok"));

  // Disabling one route does not affect its sibling's override state.
  service.store.setManualOverride("openrouter-kimi", "disabled");
  assert.equal(service.store.getManualOverride("openrouter-kimi"), "disabled");
  assert.equal(service.store.getManualOverride("openrouter-grok"), null);

  // Each route's InProcessScheduler.poll() records its OWN status row —
  // the shared credential does not cause the two routes' state to collide.
  const kimiSchedulerIndex = 2;
  const grokSchedulerIndex = 3;
  await service.inProcessSchedulers[kimiSchedulerIndex].poll();
  await service.inProcessSchedulers[grokSchedulerIndex].poll();

  const kimiStatus = service.store.getCurrentStatus("openrouter-kimi");
  const grokStatus = service.store.getCurrentStatus("openrouter-grok");
  assert.equal(kimiStatus?.status, "up");
  assert.equal(grokStatus?.status, "up");

  service.stopAll();
});

test("an ollama-provider lane gets a real pipeline + schedulers wired up, resolving up end-to-end", async () => {
  const env = testEnv();
  env.HEIMDALL_LANE_3_ID = "ollama-local";
  env.HEIMDALL_LANE_3_PROVIDER = "ollama";
  env.HEIMDALL_LANE_3_CREDENTIAL_REF = "OLLAMA_HOST";
  env.OLLAMA_HOST = "http://localhost:11434"; // credential_ref repurposed to carry a base URL

  const service = composeService({
    env,
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });

  assert.equal(service.multicaSchedulers.length, 3);
  assert.equal(service.inProcessSchedulers.length, 3);
  assert.equal(service.pipelines.size, 3);

  service.store.recordStatus({
    lane_id: "ollama-local",
    status: "degraded",
    reset_at: null,
    reason: "seeded for test",
    signal_source: "active_probe",
    observed_at: "2026-08-13T15:00:00.000Z",
  });

  const ollamaSchedulerIndex = 2;
  await service.inProcessSchedulers[ollamaSchedulerIndex].poll();

  const current = service.store.getCurrentStatus("ollama-local");
  assert.equal(current?.status, "up");

  service.stopAll();
});

test("an ollama-provider lane resolves to down end-to-end when the local daemon is unreachable", async () => {
  const env = testEnv();
  env.HEIMDALL_LANE_3_ID = "ollama-local";
  env.HEIMDALL_LANE_3_PROVIDER = "ollama";
  env.HEIMDALL_LANE_3_CREDENTIAL_REF = "OLLAMA_HOST";
  env.OLLAMA_HOST = "http://localhost:11434";

  const unreachableFetch: typeof fetch = (async (url: unknown) => {
    if (typeof url === "string" && url.includes("11434")) {
      throw new Error("ECONNREFUSED");
    }
    return mockFetch()(url as string, {});
  }) as typeof fetch;

  const service = composeService({
    env,
    commandRunner: mockCommandRunner(),
    fetchImpl: unreachableFetch,
    skipHttpListen: true,
    port: 0,
  });

  const ollamaSchedulerIndex = 2;
  // Corroboration (hdl-429-corroboration) requires two consecutive matching
  // severe verdicts before trusting "down" — a single probe resolves to
  // "degraded" instead, by design.
  await service.inProcessSchedulers[ollamaSchedulerIndex].poll();
  await service.inProcessSchedulers[ollamaSchedulerIndex].poll();

  const current = service.store.getCurrentStatus("ollama-local");
  assert.equal(current?.status, "down");

  service.stopAll();
});

test("unknown provider is skipped gracefully — no pipeline/scheduler crash for the whole service", () => {
  const env = testEnv();
  env.HEIMDALL_LANE_3_ID = "some-new-provider-lane";
  env.HEIMDALL_LANE_3_PROVIDER = "some-fictional-llm-provider"; // not registered in PROVIDER_ADAPTERS
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

test("a lane with a HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS mapping still gets StubControlAdapter even when MULTICA_* env is configured (hdl-msh-01: real actuation retired)", () => {
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

  assert.equal(service.controlAdapters.get("claude@mathew.dostal")?.constructor.name, "StubControlAdapter");
  assert.equal(service.controlAdapters.get("codex")?.constructor.name, "StubControlAdapter");

  service.stopAll();
});

test("reconcile() is event-driven: never called across unchanged ticks, exactly once per transition (PANT-827)", async () => {
  const service = composeService({
    env: testEnv(),
    commandRunner: mockCommandRunner(),
    fetchImpl: mockFetch(),
    skipHttpListen: true,
    port: 0,
  });
  // Isolate from the InProcessSchedulers' startup probe (PANT-753), which
  // would otherwise record its own statuses underneath the injected ticks.
  for (const s of service.inProcessSchedulers) s.stop();

  const laneId = "claude@mathew.dostal";
  const tick = (status: "up" | "down", observedAt: string) =>
    service.store.recordStatus({
      lane_id: laneId,
      status,
      reset_at: null,
      reason: "injected tick",
      signal_source: "active_probe",
      observed_at: observedAt,
    });

  tick("down", "2026-07-25T12:00:00.000Z");

  const adapter = service.controlAdapters.get(laneId)!;
  const reconcileCalls: string[] = [];
  adapter.reconcile = async (_lane, status) => {
    reconcileCalls.push(status);
  };

  // Several ticks, same resolved status — no transition, so no reconcile().
  tick("down", "2026-07-25T12:00:05.000Z");
  tick("down", "2026-07-25T12:00:10.000Z");
  tick("down", "2026-07-25T12:00:15.000Z");
  // Wall-clock time passing must not trigger it either (no timer left).
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reconcileCalls, []);

  // One transition -> exactly one call.
  tick("up", "2026-07-25T12:00:20.000Z");
  tick("up", "2026-07-25T12:00:25.000Z");
  assert.deepEqual(reconcileCalls, ["up"]);

  // A manual override change reconciles too; re-setting the same value doesn't.
  service.store.setManualOverride(laneId, "disabled");
  service.store.setManualOverride(laneId, "disabled");
  assert.deepEqual(reconcileCalls, ["up", "up"]);

  service.stopAll();
});

test("src/main.ts has no setInterval — nothing polls (PANT-827)", () => {
  const source = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
  assert.ok(!/setInterval\s*\(/.test(source), "main.ts must not start any setInterval loop");
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
