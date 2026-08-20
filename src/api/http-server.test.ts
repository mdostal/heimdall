import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHttpServer,
  getLaneStatuses,
  setLaneOverride,
  setLaneResetAt,
  setLaneHeadroom,
  setLaneCostTier,
  addLane,
  setBackoffPolicy,
} from "./http-server.js";
import { LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import { EnvCredentialSource } from "../core/credential-source.js";
import { LANE_STATUS_VALUES, SIGNAL_SOURCES } from "../core/status-model.js";
import { LanePipeline, claudeAdapters } from "../core/lane-pipeline.js";
import { RotationController, ProviderScopedLaneRegistry } from "../core/rotation-controller.js";

/** Never the real repo .env — every POST /lanes test uses one of these, cleaned up after. */
function tmpEnvPath(): string {
  return path.join(os.tmpdir(), `heimdall-http-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
}

function registryWithOneConfiguredLane(): LaneRegistry {
  const env = { CLAUDE_TOKEN: "secret" };
  return new LaneRegistry(
    [{ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" }],
    new EnvCredentialSource(env),
  );
}

function registryWithRouteLanes(): LaneRegistry {
  return new LaneRegistry(
    [
      {
        lane_id: "claude@mathew.dostal",
        provider: "claude",
        model: "claude-sonnet",
        credential_ref: "CLAUDE_TOKEN",
      },
      {
        lane_id: "codex",
        provider: "codex",
        model: "gpt-codex",
        credential_ref: "CODEX_TOKEN",
      },
      {
        lane_id: "kimi",
        provider: "kimi",
        model: "kimi-k3",
        credential_ref: "KIMI_TOKEN",
      },
    ],
    new EnvCredentialSource({
      CLAUDE_TOKEN: "secret-claude",
      CODEX_TOKEN: "secret-codex",
      KIMI_TOKEN: "secret-kimi",
    }),
  );
}

test("getLaneStatuses returns entries matching the LaneRouterContract shape", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const lanes = getLaneStatuses(registry, store);

  assert.ok(Array.isArray(lanes));
  assert.equal(lanes.length, 1);
  for (const lane of lanes) {
    assert.equal(typeof lane.lane_id, "string");
    assert.equal(typeof lane.provider, "string");
    assert.ok(LANE_STATUS_VALUES.includes(lane.status), `unexpected status: ${lane.status}`);
    assert.ok(lane.reset_at === null || typeof lane.reset_at === "string");
    assert.ok(lane.reason === null || typeof lane.reason === "string");
    assert.equal(typeof lane.last_updated, "string");
    assert.ok(
      SIGNAL_SOURCES.includes(lane.signal_source),
      `unexpected signal_source: ${lane.signal_source}`,
    );
  }
  store.close();
});

test("GET /lanes returns 200 with JSON matching getLaneStatuses", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.deepEqual(body, getLaneStatuses(registry, store));
  } finally {
    server.close();
    store.close();
  }
});

test("GET /lanes reflects a status persisted by the Claude signal pipeline (lhs-03f end-to-end)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const lane = registry.get("claude@mathew.dostal");
  assert.ok(lane);

  const pipeline = new LanePipeline(
    store,
    {
      now: () => "2026-07-25T12:00:00.000Z",
      lastPassiveResponse: () => null,
      fetchImpl: (async (url: unknown) => {
        if (typeof url === "string" && url.includes("status.claude.com")) {
          return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
        }
        return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
      }) as typeof fetch,
    },
    claudeAdapters(),
  );
  await pipeline.refresh(lane!);

  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`);
    const body = await res.json();
    assert.equal(body[0].status, "up");
    assert.equal(body[0].signal_source, "active_probe");
  } finally {
    server.close();
    store.close();
  }
});

test("POST /lanes/:laneId/refresh returns 501 when no refresh function is wired", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store); // no refreshLane
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/refresh`, {
      method: "POST",
    });
    assert.equal(res.status, 501);
  } finally {
    server.close();
    store.close();
  }
});

test("POST /lanes/:laneId/refresh triggers the wired refresh function and returns 200", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  let refreshedLaneId: string | null = null;
  const server = createHttpServer(registry, store, async (laneId) => {
    refreshedLaneId = laneId;
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(
      `http://localhost:${port}/lanes/${encodeURIComponent("claude@mathew.dostal")}/refresh`,
      { method: "POST" },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lane_id, "claude@mathew.dostal");
    assert.equal(refreshedLaneId, "claude@mathew.dostal");
  } finally {
    server.close();
    store.close();
  }
});

test("POST /lanes/:laneId/refresh returns 404 for an unknown lane", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store, async () => {});
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/never-declared/refresh`, {
      method: "POST",
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
    store.close();
  }
});

test("POST /lanes/:laneId/refresh returns 500 if the refresh function rejects", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store, async () => {
    throw new Error("provider unreachable");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(
      `http://localhost:${port}/lanes/${encodeURIComponent("claude@mathew.dostal")}/refresh`,
      { method: "POST" },
    );
    assert.equal(res.status, 500);
  } finally {
    server.close();
    store.close();
  }
});

test("GET /available-route returns an up lane with headroom and a token ref for the task type", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({
    lane_id: "claude@mathew.dostal",
    provider: "claude",
    credential_ref: "CLAUDE_TOKEN",
  });
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  store.upsertLane({ lane_id: "kimi", provider: "kimi", credential_ref: "KIMI_TOKEN" });
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  store.recordStatus({
    lane_id: "codex",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  store.recordStatus({
    lane_id: "kimi",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      runtime: "codex",
      model: "gpt-codex",
      "token-ref": "CODEX_TOKEN",
      lane_id: "codex",
      task_type: "build",
      headroom: true,
      model_substituted: false, // hdl-mcr-01 — no model_catalog data for this test's provider, so byte-identical to pre-epic behavior
    });
    assert.equal(JSON.stringify(body).includes("secret-codex"), false);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ot-02: GET /available-route records a model_substitution telemetry event when the declared model is disabled", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  store.recordStatus({ lane_id: "codex", status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: "2026-08-05T16:00:00.000Z" });
  store.upsertModelSeen({ provider: "codex", model_id: "gpt-codex", default_enabled: false, provider_created_at: "2024-01-01T00:00:00Z", seen_at: "2026-08-14T00:00:00Z" });
  store.upsertModelSeen({ provider: "codex", model_id: "gpt-codex-newer", default_enabled: true, provider_created_at: "2026-06-01T00:00:00Z", seen_at: "2026-08-14T00:00:00Z" });
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    const body = await res.json();
    assert.equal(body.model_substituted, true);
    assert.equal(body.model, "gpt-codex-newer");

    const counts = store.getTelemetryEventCounts("model_substitution");
    assert.equal(counts.length, 1);
    assert.equal(counts[0].labels.declaredModel, "gpt-codex");
    assert.equal(counts[0].labels.effectiveModel, "gpt-codex-newer");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ot-02: GET /available-route does NOT record a model_substitution event when the declared model is used as-is", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  store.recordStatus({ lane_id: "codex", status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: "2026-08-05T16:00:00.000Z" });
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    const body = await res.json();
    assert.equal(body.model_substituted, false);
    assert.deepEqual(store.getTelemetryEventCounts("model_substitution"), []);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-01: GET /available-route skips a lane whose manual_override is 'disabled', even though its sensed status is 'up'", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  store.upsertLane({ lane_id: "kimi", provider: "kimi", credential_ref: "KIMI_TOKEN" });
  for (const laneId of ["claude@mathew.dostal", "codex", "kimi"]) {
    store.recordStatus({
      lane_id: laneId,
      status: "up",
      reset_at: null,
      reason: null,
      signal_source: "active_probe",
      observed_at: "2026-08-05T16:00:00.000Z",
    });
  }
  // codex would normally win task-type=build (RUNTIME_PRIORITY.build[0]) —
  // disable it via override and confirm routing goes to claude instead.
  store.setManualOverride("codex", "disabled");

  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lane_id, "claude@mathew.dostal", "codex must be skipped despite sensed status 'up' — override 'disabled' wins");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-01: GET /available-route includes a lane whose manual_override is 'enabled', even though its sensed status is 'down'", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  store.recordStatus({
    lane_id: "codex",
    status: "down",
    reset_at: null,
    reason: "provider outage",
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  store.setManualOverride("codex", "enabled");

  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lane_id, "codex", "override 'enabled' must win over sensed status 'down'");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-01: GET /available-route with manual_override unset (null) is unaffected — a down lane is still excluded", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  store.recordStatus({
    lane_id: "codex",
    status: "down",
    reset_at: null,
    reason: "provider outage",
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  // no setManualOverride call — stays null

  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
    store.close();
  }
});

test("GET /available-route skips lanes without headroom or a resolved token", async () => {
  const registry = new LaneRegistry(
    [
      {
        lane_id: "codex",
        provider: "codex",
        model: "gpt-codex",
        credential_ref: "CODEX_TOKEN",
      },
      {
        lane_id: "claude@mathew.dostal",
        provider: "claude",
        model: "claude-sonnet",
        credential_ref: "CLAUDE_TOKEN",
      },
      {
        lane_id: "gemini",
        provider: "gemini",
        model: "gemini-pro",
        credential_ref: "MISSING_TOKEN",
      },
    ],
    new EnvCredentialSource({
      CODEX_TOKEN: "secret-codex",
      CLAUDE_TOKEN: "secret-claude",
    }),
  );
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  store.upsertLane({
    lane_id: "claude@mathew.dostal",
    provider: "claude",
    credential_ref: "CLAUDE_TOKEN",
  });
  store.upsertLane({ lane_id: "gemini", provider: "gemini", credential_ref: "MISSING_TOKEN" });
  store.recordStatus({
    lane_id: "codex",
    status: "out_of_credit",
    reset_at: "2026-08-06T00:00:00.000Z",
    reason: "weekly cap reached",
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  store.recordStatus({
    lane_id: "gemini",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.runtime, "claude");
    assert.equal(body["token-ref"], "CLAUDE_TOKEN");
  } finally {
    server.close();
    store.close();
  }
});

test("GET /available-route returns 400 for an invalid task type", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=ops`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_task_type");
    assert.deepEqual(body.allowed_task_types, ["planning", "build", "review"]);
  } finally {
    server.close();
    store.close();
  }
});

test("GET /available-route returns 404 when no usable lane has headroom and a valid token", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({
    lane_id: "claude@mathew.dostal",
    provider: "claude",
    credential_ref: "CLAUDE_TOKEN",
  });
  store.recordStatus({
    lane_id: "claude@mathew.dostal",
    status: "down",
    reset_at: null,
    reason: "runtime unavailable",
    signal_source: "active_probe",
    observed_at: "2026-08-05T16:00:00.000Z",
  });
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=planning`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: "no_available_route", task_type: "planning" });
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-unified-dashboard: GET /theme defaults to 'mission-control' active with all 3 themes listed", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/theme`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.active, "mission-control");
    assert.deepEqual(body.available.sort(), ["harbor-watch", "mission-control", "terminal"]);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-unified-dashboard: POST /theme sets the active theme, GET /theme and GET / (data-theme attribute) both reflect it", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const setRes = await fetch(`http://localhost:${port}/theme`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "terminal" }),
    });
    assert.equal(setRes.status, 200);
    assert.equal((await setRes.json()).active, "terminal");

    const getRes = await fetch(`http://localhost:${port}/theme`);
    assert.equal((await getRes.json()).active, "terminal");

    const pageRes = await fetch(`http://localhost:${port}/`);
    const body = await pageRes.text();
    assert.match(body, /<html lang="en" data-theme="terminal">/, "the server-rendered page must set data-theme so the correct theme paints on first load, not just after client JS runs");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-unified-dashboard: POST /theme with an unrecognized name returns 400 and does NOT change the active theme", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/theme`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "not-a-real-theme" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_theme");

    const getRes = await fetch(`http://localhost:${port}/theme`);
    assert.equal((await getRes.json()).active, "mission-control", "an invalid POST must not change the persisted setting");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-unified-dashboard: GET / does not set a data-theme attribute for the default mission-control theme", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /<html lang="en">/, "Mission Control needs no data-theme attribute -- the bare :root CSS already IS Mission Control");
    assert.doesNotMatch(
      body,
      /<html lang="en" data-theme=/,
      "the <html> tag itself must not carry data-theme for the default theme (CSS legitimately contains data-theme= as selector text for the other two themes' blocks, so this must check the tag specifically, not the whole document)",
    );
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-desktop-icon-settings: GET /desktop-icon defaults to 'watchtower' active with all 3 icons listed", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/desktop-icon`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.active, "watchtower");
    assert.deepEqual(body.available.sort(), ["routing-lanes", "signal-horn", "watchtower"]);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-icon-reconciliation: GET /desktop-icon/:name/thumbnail.png serves a real PNG for each valid icon", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    for (const name of ["watchtower", "routing-lanes", "signal-horn"]) {
      const res = await fetch(`http://localhost:${port}/desktop-icon/${name}/thumbnail.png`);
      assert.equal(res.status, 200, `${name} thumbnail should exist`);
      assert.equal(res.headers.get("content-type"), "image/png");
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 100, `${name} thumbnail should be a real, non-trivial PNG`);
      // PNG magic bytes
      assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-icon-reconciliation: GET /desktop-icon/:name/thumbnail.png rejects an unrecognized or path-traversal name", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const badName = await fetch(`http://localhost:${port}/desktop-icon/not-a-real-icon/thumbnail.png`);
    assert.equal(badName.status, 404);
    assert.equal((await badName.json()).error, "unknown_icon");

    const traversal = await fetch(`http://localhost:${port}/desktop-icon/..%2F..%2F..%2Fetc%2Fpasswd/thumbnail.png`);
    assert.equal(traversal.status, 404, "must never resolve an arbitrary caller-supplied path");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-icon-reconciliation: GET / (dashboard) icon picker uses real thumbnail images, not emoji placeholders", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /icon-thumb/, "must render an <img class=\"icon-thumb\"> per option");
    assert.match(body, /\/desktop-icon\/" \+ escapeHtml\(name\) \+\s*"\/thumbnail\.png/, "must load each thumbnail from the real per-icon route");
    assert.doesNotMatch(body, /ICON_GLYPHS/, "the emoji-placeholder table must be gone, not just unused");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-desktop-icon-settings: POST /desktop-icon sets the preference, invalid values are rejected without changing it", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const setRes = await fetch(`http://localhost:${port}/desktop-icon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ icon: "signal-horn" }),
    });
    assert.equal(setRes.status, 200);
    assert.equal((await setRes.json()).active, "signal-horn");

    const badRes = await fetch(`http://localhost:${port}/desktop-icon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ icon: "not-a-real-icon" }),
    });
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).error, "invalid_icon");

    const getRes = await fetch(`http://localhost:${port}/desktop-icon`);
    assert.equal((await getRes.json()).active, "signal-horn", "the invalid POST must not have changed the persisted setting");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-unified-dashboard: GET / (dashboard) includes a Settings panel with theme and icon pickers", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /id="theme-picker"/);
    assert.match(body, /fetch\("\/theme"\)/, "theme picker must load from GET /theme");
    assert.match(body, /id="icon-picker"/);
    assert.match(body, /fetch\("\/desktop-icon"\)/, "icon picker must load from GET /desktop-icon");
    assert.match(body, /cargo tauri build/, "must be honest that the Dock icon needs a rebuild, not silently imply a full live swap");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ao-07: GET /agent-onboarding-dismissed defaults to false", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/agent-onboarding-dismissed`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).dismissed, false);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ao-07: POST /agent-onboarding-dismissed persists true, GET reflects it, and GET / renders the panel collapsed", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const setRes = await fetch(`http://localhost:${port}/agent-onboarding-dismissed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dismissed: true }),
    });
    assert.equal(setRes.status, 200);
    assert.equal((await setRes.json()).dismissed, true);

    const getRes = await fetch(`http://localhost:${port}/agent-onboarding-dismissed`);
    assert.equal((await getRes.json()).dismissed, true);

    const pageRes = await fetch(`http://localhost:${port}/`);
    const body = await pageRes.text();
    assert.match(
      body,
      /id="agent-onboarding-collapsed" style="display:flex;"/,
      "reload after dismiss must render the panel already collapsed server-side, not rely on client JS alone",
    );
    assert.match(body, /id="agent-onboarding-expanded" style="display:none;"/);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ao-07: POST /agent-onboarding-dismissed with a non-boolean value returns 400 and does not change the setting", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/agent-onboarding-dismissed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dismissed: "yes" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_dismissed");

    const getRes = await fetch(`http://localhost:${port}/agent-onboarding-dismissed`);
    assert.equal((await getRes.json()).dismissed, false, "an invalid POST must not change the persisted setting");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ao-07: GET / (dashboard) first panel has the real, live curl one-liner and heimdall agent init command, not placeholder text", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /curl -fsSL https:\/\/mdostal\.github\.io\/heimdall\/install\.sh \| bash/);
    assert.match(body, /heimdall agent init/);
    assert.match(body, /~\/\.claude\/skills\//);
    assert.match(body, /id="agent-onboarding-panel"/);
    // Above Fleet Scope: the panel markup must appear earlier in the BODY
    // than the Fleet Scope heading (the CSS block, which legitimately
    // contains the substring "Fleet Scope" in a comment, precedes the body
    // entirely, so this checks the real <h2> heading specifically).
    assert.ok(
      body.indexOf("id=\"agent-onboarding-panel\"") < body.indexOf("<h2>Fleet Scope</h2>"),
      "the get-started panel must render as the first panel, above Fleet Scope",
    );
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rr-03: GET /routing-strategy defaults to 'priority' active with all 4 strategies listed as available", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/routing-strategy`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.active, "priority");
    assert.deepEqual(body.available.sort(), ["off", "priority", "round-robin", "scored"]);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-03: POST /routing-strategy sets the active strategy, and GET /routing-strategy reflects it", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const setRes = await fetch(`http://localhost:${port}/routing-strategy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: "round-robin" }),
    });
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.active, "round-robin");

    const getRes = await fetch(`http://localhost:${port}/routing-strategy`);
    const getBody = await getRes.json();
    assert.equal(getBody.active, "round-robin");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-03: POST /routing-strategy with an unrecognized name returns 400 and does NOT change the active strategy", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/routing-strategy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: "not-a-real-strategy" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_strategy");

    const getRes = await fetch(`http://localhost:${port}/routing-strategy`);
    assert.equal((await getRes.json()).active, "priority", "an invalid POST must not change the persisted setting");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-da-03: GET /routing-policy returns the real config/routing-policy.yaml, read-only", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/routing-policy`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, "1.0");
    assert.ok(body.task_type_weights.planning, "expected the real policy's planning task-type weights");
    assert.equal(typeof body.headroom_floor, "number");
    assert.ok(["quality", "balanced", "economy"].includes(body.cost_preference));
    assert.equal(typeof body.experiments.enabled, "boolean");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-03: with the 'off' strategy active, GET /available-route always returns no_available_route, regardless of eligible candidates", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  for (const laneId of ["claude@mathew.dostal", "codex"]) {
    store.recordStatus({
      lane_id: laneId,
      status: "up",
      reset_at: null,
      reason: null,
      signal_source: "active_probe",
      observed_at: "2026-08-05T16:00:00.000Z",
    });
  }
  store.setSetting("routing_strategy", "off");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "no_available_route");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-03: with the 'round-robin' strategy active, consecutive GET /available-route calls pick different lanes", async () => {
  const registry = registryWithRouteLanes();
  const store = new StateStore(":memory:");
  store.upsertLane({ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" });
  store.upsertLane({ lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" });
  for (const laneId of ["claude@mathew.dostal", "codex"]) {
    store.recordStatus({
      lane_id: laneId,
      status: "up",
      reset_at: null,
      reason: null,
      signal_source: "active_probe",
      observed_at: "2026-08-05T16:00:00.000Z",
    });
  }
  store.setSetting("routing_strategy", "round-robin");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const first = await (await fetch(`http://localhost:${port}/available-route?task-type=build`)).json();
    const second = await (await fetch(`http://localhost:${port}/available-route?task-type=build`)).json();
    assert.notEqual(first.lane_id, second.lane_id, "round-robin must not pick the same lane twice in a row with 2 eligible candidates");
  } finally {
    server.close();
    store.close();
  }
});

test("unknown routes return 404", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
    store.close();
  }
});

test("GET /healthz returns 200 without touching the registry or store", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.equal(body.status, "ok");
  } finally {
    server.close();
    store.close();
  }
});

test("GET / (hdl-ui-01) returns 200 text/html and references /lanes for its data", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /<table|<div id="root"/);
    assert.match(body, /fetch\("\/lanes"\)/, "the dashboard must fetch its data from Heimdall's own /lanes endpoint");
    // hdl-ao-07: the get-started panel legitimately displays a real external
    // URL as copy-paste text (the live install.sh curl one-liner) — that's
    // documentation content, not a network call the page itself makes. What
    // this test actually guards against is the page fetching assets FROM an
    // external host (CDN scripts/styles/fetches), so it checks those tags
    // specifically rather than banning any https:// substring in the body.
    assert.doesNotMatch(body, /<script[^>]+src="https?:\/\/(?!localhost)/, "no external <script src> (CDN scripts)");
    assert.doesNotMatch(body, /<link[^>]+href="https?:\/\/(?!localhost)/, "no external <link href> (CDN styles)");
    assert.doesNotMatch(body, /fetch\("https?:\/\/(?!localhost)/, "no external fetch() calls");
  } finally {
    server.close();
    store.close();
  }
});

test("GET / returns 200 even with zero declared lanes (empty-state is a client-side render, not a server error)", async () => {
  const registry = new LaneRegistry([], new EnvCredentialSource({}));
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /No lanes declared/, "the client-side empty-state message must be present in the served script");
  } finally {
    server.close();
    store.close();
  }
});

test("GET / (hdl-ui-01) — the served script guards against a null reset_at (structural check, no DOM execution)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(
      body,
      /if\s*\(\s*!resetAt\s*\)\s*return\s*""/,
      "formatResetAt must return an empty string for a null/falsy reset_at rather than formatting 'null' or producing Invalid Date",
    );
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-mcp-01: setLaneOverride is independently callable without an HTTP server", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    const result = setLaneOverride(registry, store, "claude@mathew.dostal", "disabled");
    assert.deepEqual(result, {
      ok: true,
      lane_id: "claude@mathew.dostal",
      manual_override: "disabled",
      override_reason: null,
    });
    assert.equal(store.getManualOverride("claude@mathew.dostal"), "disabled");
  } finally {
    store.close();
  }
});

test("hdl-mcp-01: setLaneOverride returns {ok: false, error: 'unknown_lane', ...} for an undeclared lane — the exact shape the HTTP route 404s with", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    const result = setLaneOverride(registry, store, "never-declared", "disabled");
    assert.deepEqual(result, { ok: false, error: "unknown_lane", lane_id: "never-declared" });
  } finally {
    store.close();
  }
});

test("hdl-mcp-01: setLaneOverride returns {ok: false, error: 'invalid_override_state', ...} for a bad state value", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    const result = setLaneOverride(registry, store, "claude@mathew.dostal", "not-a-real-state");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_override_state");
      assert.deepEqual(result.allowed_states.sort(), ["auto", "disabled", "enabled"]);
    }
  } finally {
    store.close();
  }
});

test("hdl-mcp-01: setLaneResetAt is independently callable without an HTTP server", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  try {
    const result = setLaneResetAt(registry, store, "claude@mathew.dostal", future);
    assert.deepEqual(result, { ok: true, lane_id: "claude@mathew.dostal", manual_reset_at: future });
    assert.equal(store.getManualResetAt("claude@mathew.dostal"), future);
  } finally {
    store.close();
  }
});

test("hdl-mcp-01: setLaneResetAt returns {ok: false, error: 'unknown_lane', ...} for an undeclared lane", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    const result = setLaneResetAt(registry, store, "never-declared", new Date(Date.now() + 60_000).toISOString());
    assert.deepEqual(result, { ok: false, error: "unknown_lane", lane_id: "never-declared" });
  } finally {
    store.close();
  }
});

test("hdl-mcp-01: setLaneResetAt(..., null) clears it and returns manual_reset_at: null", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    store.setManualResetAt("claude@mathew.dostal", new Date(Date.now() + 60_000).toISOString());
    const result = setLaneResetAt(registry, store, "claude@mathew.dostal", null);
    assert.deepEqual(result, { ok: true, lane_id: "claude@mathew.dostal", manual_reset_at: null });
  } finally {
    store.close();
  }
});

test("hdl-mcp-01: setLaneResetAt rejects a past timestamp with {ok: false, error: 'reset_at_in_the_past'}", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    const result = setLaneResetAt(registry, store, "claude@mathew.dostal", "2020-01-01T00:00:00.000Z");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "reset_at_in_the_past");
  } finally {
    store.close();
  }
});

test("hdl-mcp-01: addLane is independently callable without an HTTP server — unchanged response shape (restart_required, restart_command, no automatic restart)", () => {
  const registry = registryWithOneConfiguredLane();
  const envPath = tmpEnvPath();
  try {
    const result = addLane(registry, envPath, {
      lane_id: "gemini@ops",
      provider: "gemini",
      model: "gemini-3-pro",
      token: "secret-value",
    });
    assert.deepEqual(result, {
      ok: true,
      lane_id: "gemini@ops",
      credential_ref: "GEMINI_OPS_TOKEN",
      restart_required: true,
      restart_command: "npm run dev",
    });
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-mcp-01: addLane returns {ok: false, error: 'missing_field', field} naming the missing field", () => {
  const registry = registryWithOneConfiguredLane();
  const envPath = tmpEnvPath();
  try {
    const result = addLane(registry, envPath, { lane_id: "gemini@ops", provider: "gemini", model: "gemini-3-pro" });
    assert.deepEqual(result, { ok: false, error: "missing_field", field: "token" });
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-mcp-01: addLane returns {ok: false, error: 'lane_already_declared', ...} for a lane already in the registry", () => {
  const registry = registryWithOneConfiguredLane();
  const envPath = tmpEnvPath();
  try {
    const result = addLane(registry, envPath, {
      lane_id: "claude@mathew.dostal",
      provider: "claude",
      model: "claude-sonnet",
      token: "x",
    });
    assert.deepEqual(result, { ok: false, error: "lane_already_declared", lane_id: "claude@mathew.dostal" });
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-lm-01: POST /lanes creates a lane, writes .env, and responds with restart_required", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const envPath = tmpEnvPath();
  const server = createHttpServer(registry, store, undefined, envPath);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane_id: "gemini@ops", provider: "gemini", model: "gemini-3-pro", token: "secret-value" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.lane_id, "gemini@ops");
    assert.equal(body.credential_ref, "GEMINI_OPS_TOKEN");
    assert.equal(body.restart_required, true);
    assert.equal(body.restart_command, "npm run dev");

    // envPath starts empty in this test (independent of the in-memory
    // registry fixture, which is constructed programmatically, not from
    // this file) — appendLane's index-continuation logic is covered
    // separately and thoroughly in env-file.test.ts.
    const envContent = fs.readFileSync(envPath, "utf8");
    assert.match(envContent, /HEIMDALL_LANE_1_ID=gemini@ops/);
    assert.match(envContent, /GEMINI_OPS_TOKEN=secret-value/);
  } finally {
    server.close();
    store.close();
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-lm-01: POST /lanes rejects a duplicate lane_id with 409", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const envPath = tmpEnvPath();
  const server = createHttpServer(registry, store, undefined, envPath);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane_id: "claude@mathew.dostal", provider: "claude", model: "claude-sonnet", token: "x" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "lane_already_declared");
  } finally {
    server.close();
    store.close();
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-lm-01: POST /lanes with a missing field returns 400 naming the field", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const envPath = tmpEnvPath();
  const server = createHttpServer(registry, store, undefined, envPath);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane_id: "gemini@ops", provider: "gemini", model: "gemini-3-pro" }), // no token
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "missing_field");
    assert.equal(body.field, "token");
  } finally {
    server.close();
    store.close();
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-lm-01: POST /lanes with malformed JSON returns 400, not a crash", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const envPath = tmpEnvPath();
  const server = createHttpServer(registry, store, undefined, envPath);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_json");
  } finally {
    server.close();
    store.close();
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-lm-02: GET /lanes reports credential_configured: true for a lane whose credential resolved", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`);
    const body = await res.json();
    assert.equal(body[0].credential_configured, true);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-02: GET /lanes reports credential_configured: false for a lane with an unresolved credential_ref, and never leaks the secret's env var name/value as a raw field", async () => {
  const registry = new LaneRegistry(
    [{ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "MISSING_TOKEN_VAR" }],
    new EnvCredentialSource({}), // MISSING_TOKEN_VAR is not set
  );
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`);
    const rawBody = await res.text();
    const body = JSON.parse(rawBody);
    assert.equal(body[0].credential_configured, false);
    assert.doesNotMatch(rawBody, /"credential":/, "the raw Lane.credential field must never be serialized");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-or-03: GET /lanes includes each lane's model and credential_ref (env-var name, not a secret)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`);
    const rawBody = await res.text();
    const body = JSON.parse(rawBody);
    assert.equal(body[0].credential_ref, "CLAUDE_TOKEN");
    assert.equal(body[0].model, "claude"); // no explicit model declared — falls back to provider
    assert.doesNotMatch(rawBody, /"secret"/, "the resolved secret VALUE must never be serialized");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-03: GET /lanes includes each lane's manual_reset_at (null when unset)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`);
    const body = await res.json();
    assert.equal(body[0].manual_reset_at, null);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-03: POST /lanes/:laneId/reset-at sets it and GET /lanes reflects it", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  try {
    const setRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/reset-at`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset_at: future }),
    });
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.manual_reset_at, future);

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    const lanes = await lanesRes.json();
    assert.equal(lanes[0].manual_reset_at, future);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-03: POST /lanes/:laneId/reset-at with reset_at: null clears a previously-set value", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  try {
    await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/reset-at`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset_at: future }),
    });
    const clearRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/reset-at`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset_at: null }),
    });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assert.equal(clearBody.manual_reset_at, null);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-03: POST /lanes/:laneId/reset-at for an unknown lane returns 404", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/never-declared/reset-at`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "unknown_lane");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-03: POST /lanes/:laneId/reset-at rejects a malformed timestamp with 400", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/reset-at`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset_at: "not-a-real-timestamp" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_reset_at");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-03: POST /lanes/:laneId/reset-at rejects a past timestamp with 400", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/reset-at`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset_at: "2020-01-01T00:00:00.000Z" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "reset_at_in_the_past");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/headroom sets it and GET /lanes reflects it", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const setRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/headroom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headroom: 500 }),
    });
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.manual_headroom, 500);

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    const lanes = await lanesRes.json();
    assert.equal(lanes[0].manual_headroom, 500);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/headroom with headroom: null clears a previously-set value", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/headroom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headroom: 500 }),
    });
    const clearRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/headroom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headroom: null }),
    });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assert.equal(clearBody.manual_headroom, null);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/headroom for an unknown lane returns 404", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/never-declared/headroom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headroom: 500 }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "unknown_lane");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/headroom rejects a negative number with a structured 400, and GET /lanes still shows the lane", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/headroom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headroom: -5 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_headroom");

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    const lanes = await lanesRes.json();
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].lane_id, "claude@mathew.dostal");
    assert.equal(lanes[0].manual_headroom, null);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/headroom rejects a non-finite value (NaN/Infinity via a non-number) with a structured 400", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/headroom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headroom: "not-a-number" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_headroom");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/cost-tier sets it and GET /lanes reflects it", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const setRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/cost-tier`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cost_tier: "high" }),
    });
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.manual_cost_tier, "high");

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    const lanes = await lanesRes.json();
    assert.equal(lanes[0].manual_cost_tier, "high");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/cost-tier with cost_tier: null clears a previously-set value", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/cost-tier`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cost_tier: "high" }),
    });
    const clearRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/cost-tier`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cost_tier: null }),
    });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assert.equal(clearBody.manual_cost_tier, null);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/cost-tier for an unknown lane returns 404", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/never-declared/cost-tier`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cost_tier: "high" }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "unknown_lane");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/cost-tier rejects a value outside low|medium|high with a structured 400, and GET /lanes still shows the lane", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/cost-tier`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cost_tier: "ultra" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_cost_tier");
    assert.deepEqual(body.allowed_cost_tiers.sort(), ["high", "low", "medium"]);

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    const lanes = await lanesRes.json();
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].lane_id, "claude@mathew.dostal");
    assert.equal(lanes[0].manual_cost_tier, null);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-bp-01: POST /lanes/:laneId/headroom with malformed JSON returns 400, not a crash", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/headroom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_json");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-mcp-01: setLaneHeadroom/setLaneCostTier are independently callable without an HTTP server", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");

  const headroomResult = setLaneHeadroom(registry, store, "claude@mathew.dostal", 500);
  assert.deepEqual(headroomResult, { ok: true, lane_id: "claude@mathew.dostal", manual_headroom: 500 });

  const costTierResult = setLaneCostTier(registry, store, "claude@mathew.dostal", "low");
  assert.deepEqual(costTierResult, { ok: true, lane_id: "claude@mathew.dostal", manual_cost_tier: "low" });

  store.close();
});

test("hdl-lo-01: GET /lanes includes each lane's manual_override state (null when unset)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].manual_override, null);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lo-01: POST /lanes/:laneId/override sets the override and GET /lanes reflects it", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const overrideRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "disabled" }),
    });
    assert.equal(overrideRes.status, 200);
    const overrideBody = await overrideRes.json();
    assert.equal(overrideBody.manual_override, "disabled");

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    const lanes = await lanesRes.json();
    assert.equal(lanes[0].manual_override, "disabled");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-override-reason: POST /lanes/:laneId/override accepts an optional reason, GET /lanes reflects it, and auto discards it", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const overrideRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "disabled", reason: "cost review in progress" }),
    });
    assert.equal(overrideRes.status, 200);
    const overrideBody = await overrideRes.json();
    assert.equal(overrideBody.override_reason, "cost review in progress");

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    const lanes = await lanesRes.json();
    assert.equal(lanes[0].override_reason, "cost review in progress");

    const clearRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "auto", reason: "should be discarded" }),
    });
    const clearBody = await clearRes.json();
    assert.equal(clearBody.override_reason, null, "auto must discard any reason, not carry it forward");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lo-01: POST /lanes/:laneId/override with state: auto clears a previously-set override", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "enabled" }),
    });
    const clearRes = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "auto" }),
    });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assert.equal(clearBody.manual_override, null);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lo-01: POST /lanes/:laneId/override for an unknown lane returns 404", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/never-declared/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "disabled" }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "unknown_lane");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lo-01: POST /lanes/:laneId/override with an invalid state returns 400", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "not-a-real-state" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_override_state");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lo-01: POST /lanes/:laneId/override with malformed JSON returns 400, not a crash", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes/claude@mathew.dostal/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_json");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lo-02: GET / (dashboard) includes override controls calling POST /lanes/:laneId/override", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /data-lane=/, "override controls must be data-lane-tagged for the click-delegation handler to read");
    assert.match(body, /data-state=/, "override controls must be data-state-tagged (enabled/disabled/auto)");
    assert.match(body, /"\/override"/, "the click handler must POST to the lane's /override endpoint");
    assert.match(body, /addEventListener\("click"/, "must use event delegation, not per-button listeners lost on re-render");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lo-02: GET / (dashboard) renders an override indicator distinct from the status badge", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /overrideBadge/, "must render a distinct override indicator, not fold override state into the status badge");
    assert.match(body, /if \(!manualOverride\) return ""/, "the override badge must render nothing when no override is set (not 'null' or an empty badge)");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-override-reason: GET / (dashboard) renders a reason input next to the override controls, sent along with state on click", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /override-reason-input/, "must render a reason input the operator can type into before overriding");
    assert.match(
      body,
      /body: JSON\.stringify\(\{ state: state, reason: reason \}\)/,
      "the click handler must send the reason input's current value alongside state",
    );
    assert.match(body, /override-reason-note/, "must render the persisted reason as a distinct, scoped element (not the shared .reason class also used for status text and the routing-policy panel)");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-04: GET / (dashboard) includes a Routing strategy panel that loads from and saves to /routing-strategy", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /id="routing-strategy-select"/);
    assert.match(body, /id="routing-strategy-save"/);
    assert.match(body, /id="routing-strategy-status"/);
    assert.match(body, /fetch\("\/routing-strategy"\)/, "the panel must load its state from GET /routing-strategy");
    assert.match(body, /"\/routing-strategy"/, "the save control must POST to /routing-strategy");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-da-03: GET / (dashboard) includes a Routing policy panel that loads from /routing-policy", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /id="routing-policy-root"/);
    assert.match(body, /fetch\("\/routing-policy"\)/, "the panel must load its state from GET /routing-policy");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rs-04: GET / (dashboard) visibly flags the 'off' strategy's consequence — never a silent/neutral dropdown", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /function renderRoutingStrategyStatus/);
    assert.match(body, /no_available_route/, "the panel's 'off' state must explain the consequence, not just show a value");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-04: GET / (dashboard) includes an Add Lane form posting to /lanes", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /id="add-lane-form"/);
    assert.match(body, /name="lane_id"/);
    assert.match(body, /name="provider"/);
    assert.match(body, /name="model"/);
    assert.match(body, /name="token"/);
    assert.match(body, /fetch\("\/lanes"/, "the form must POST to /lanes, not a different endpoint");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-04: GET / (dashboard) shows a token-configured indicator distinct from the status/override badges", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /function tokenChip/);
    assert.match(body, /chip-missing/, "must visually distinguish a missing token, not just omit an indicator");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-lm-04: GET / (dashboard) includes an editable reset-at control calling POST /lanes/:laneId/reset-at", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /type=\\"datetime-local\\"/);
    assert.match(body, /data-reset-save/);
    assert.match(body, /"\/reset-at"/, "the save control must POST to the lane's /reset-at endpoint");
    assert.match(body, /function toDatetimeLocalValue/, "must convert the stored UTC/ISO value into the input's local-time format");
  } finally {
    server.close();
    store.close();
  }
});

test("GET / does not change existing routes' behavior", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    assert.equal(lanesRes.status, 200);
    assert.equal(lanesRes.headers.get("content-type"), "application/json");

    const healthzRes = await fetch(`http://localhost:${port}/healthz`);
    assert.equal(healthzRes.status, 200);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-mc-05: GET /models returns the catalog after a refresh, optionally filtered by provider", async () => {
  const registry = registryWithOneConfiguredLane(); // provider: claude, credential_ref: CLAUDE_TOKEN
  const store = new StateStore(":memory:");
  const fetchImpl: typeof fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-opus-5", created_at: "2026-02-04T00:00:00Z" }] }),
    }) as unknown as Response) as typeof fetch;
  const server = createHttpServer(registry, store, undefined, undefined, fetchImpl);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const refreshRes = await fetch(`http://localhost:${port}/models/refresh`, { method: "POST" });
    assert.equal(refreshRes.status, 200);
    const refreshBody = await refreshRes.json();
    assert.equal(refreshBody.modelsSeen, 1);

    const listRes = await fetch(`http://localhost:${port}/models`);
    const catalog = await listRes.json();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].model_id, "claude-opus-5");

    const filteredRes = await fetch(`http://localhost:${port}/models?provider=gemini`);
    const filtered = await filteredRes.json();
    assert.deepEqual(filtered, []);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-mc-05: POST /models/:provider/:modelId toggles enabled, reflected in a subsequent GET /models", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const fetchImpl: typeof fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-opus-5", created_at: "2026-02-04T00:00:00Z" }] }),
    }) as unknown as Response) as typeof fetch;
  const server = createHttpServer(registry, store, undefined, undefined, fetchImpl);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await fetch(`http://localhost:${port}/models/refresh`, { method: "POST" });

    const toggleRes = await fetch(`http://localhost:${port}/models/claude/claude-opus-5`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggleRes.status, 200);

    const listRes = await fetch(`http://localhost:${port}/models?provider=claude`);
    const catalog = await listRes.json();
    assert.equal(catalog[0].enabled, false);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-mc-05: POST /models/:provider/:modelId for a never-seen model returns 404 unknown_model, never a silent no-op", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/models/claude/never-seen-model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "unknown_model");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-mcd-01: GET / (dashboard) includes a Model catalog panel with a Refresh button and a container for the rendered catalog", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /id="model-catalog-refresh"/);
    assert.match(body, /id="model-catalog-root"/);
    assert.match(body, /id="model-catalog-banner"/);
    assert.match(body, /fetch\("\/models"\)/, "the panel must load its state from GET /models");
    assert.match(body, /fetch\("\/models\/refresh"/, "the Refresh button must POST to /models/refresh");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-unified-dashboard: GET / renders the model catalog as a tree (Terminal-origin widget, now universal)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /catalog-tree/, "must render the tree container class");
    assert.match(body, /tree-glyph/, "must render tree connector glyphs, not a flat table");
    assert.match(body, /model-flag/, "must render an enabled\\/disabled flag per model");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-unified-dashboard: GET / includes a Fleet Scope radar plotting lanes by severity", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /id="fleet-scope-root"/);
    assert.match(body, /SCOPE_RING/, "severity-to-ring mapping must be present");
    assert.match(body, /renderFleetScope/, "must render from the same live lane data render() receives, not separately fetched");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-mcd-01: GET / does not change existing routes' behavior (model-catalog panel is additive only)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    assert.equal(lanesRes.status, 200);
    const routingRes = await fetch(`http://localhost:${port}/routing-strategy`);
    assert.equal(routingRes.status, 200);
  } finally {
    server.close();
    store.close();
  }
});

function registryWithTwoClaudeLanes(): LaneRegistry {
  return new LaneRegistry(
    [
      { lane_id: "claude-a", provider: "claude", model: "claude-sonnet", credential_ref: "CLAUDE_A" },
      { lane_id: "claude-b", provider: "claude", model: "claude-sonnet", credential_ref: "CLAUDE_B" },
    ],
    new EnvCredentialSource({ CLAUDE_A: "secret-a", CLAUDE_B: "secret-b" }),
  );
}

test("hdl-rr-04: GET /rotation/:provider for an unmapped provider returns a structured 404, never throws", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/rotation/claude`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "unknown_provider");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rr-04: GET /rotation/:provider reports the active lane, never the resolved credential", async () => {
  const registry = registryWithTwoClaudeLanes();
  const store = new StateStore(":memory:");
  store.recordStatus({ lane_id: "claude-a", status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
  store.recordStatus({ lane_id: "claude-b", status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
  const controller = new RotationController(new ProviderScopedLaneRegistry(registry, "claude"), store);
  const rotationControllers = new Map([["claude", controller]]);
  const server = createHttpServer(registry, store, undefined, undefined, undefined, rotationControllers);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/rotation/claude`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.active_lane_id, "claude-a");
    assert.equal(JSON.stringify(body).includes("secret-a"), false, "the resolved credential must never appear in the response");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rr-04: POST /rotation/:provider/rotate advances to the next healthy lane, reflected in a subsequent GET", async () => {
  const registry = registryWithTwoClaudeLanes();
  const store = new StateStore(":memory:");
  store.recordStatus({ lane_id: "claude-a", status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
  store.recordStatus({ lane_id: "claude-b", status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
  const controller = new RotationController(new ProviderScopedLaneRegistry(registry, "claude"), store);
  const rotationControllers = new Map([["claude", controller]]);
  const server = createHttpServer(registry, store, undefined, undefined, undefined, rotationControllers);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    // Establishes the active lane first — rotateToNextHealthy() with no
    // active lane set yet picks the first healthy lane, not "the next one
    // after nothing," matching RotationController's existing, already-tested
    // fromLaneId=null semantics (rotation-controller.test.ts).
    const initialRes = await fetch(`http://localhost:${port}/rotation/claude`);
    const initialBody = await initialRes.json();
    assert.equal(initialBody.active_lane_id, "claude-a");

    const rotateRes = await fetch(`http://localhost:${port}/rotation/claude/rotate`, { method: "POST" });
    assert.equal(rotateRes.status, 200);
    const rotateBody = await rotateRes.json();
    assert.equal(rotateBody.active_lane_id, "claude-b");

    const getRes = await fetch(`http://localhost:${port}/rotation/claude`);
    const getBody = await getRes.json();
    assert.equal(getBody.active_lane_id, "claude-b");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ot-03: GET /metrics returns 200 with valid Prometheus text format on an empty store, never a crash", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const body = await res.text();
    assert.match(body, /^# HELP heimdall_lanes /m);
    assert.match(body, /^# TYPE heimdall_lanes gauge$/m);
    // A declared-but-never-probed lane still counts as a lane (status
    // defaults to "down" — same fallback GET /lanes already uses).
    assert.match(body, /heimdall_lanes\{provider="claude",status="down"\} 1/);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ot-03: GET /metrics reflects real telemetry_events counts with correct labels", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  store.recordTelemetryEvent("actuation_result", { provider: "claude", action: "disable", success: "true" });
  store.recordTelemetryEvent("actuation_result", { provider: "claude", action: "disable", success: "true" });
  store.recordTelemetryEvent("actuation_result", { provider: "claude", action: "enable", success: "false" });
  store.recordTelemetryEvent("rotation_event", { provider: "claude", kind: "capped" });
  store.recordTelemetryEvent("model_substitution", { provider: "claude" });
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/metrics`);
    const body = await res.text();
    assert.match(body, /heimdall_actuation_results_total\{provider="claude",action="disable",success="true"\} 2/);
    assert.match(body, /heimdall_actuation_results_total\{provider="claude",action="enable",success="false"\} 1/);
    assert.match(body, /heimdall_rotation_events_total\{provider="claude",kind="capped"\} 1/);
    assert.match(body, /heimdall_model_substitutions_total\{provider="claude"\} 1/);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ot-04: GET / (dashboard) includes a Telemetry panel that loads from GET /metrics", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    assert.match(body, /id="telemetry-root"/);
    assert.match(body, /fetch\("\/metrics"\)/, "the panel must load its state from GET /metrics");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-ot-04: GET / does not change existing routes' behavior (Telemetry panel is additive only)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    assert.equal(lanesRes.status, 200);
    const metricsRes = await fetch(`http://localhost:${port}/metrics`);
    assert.equal(metricsRes.status, 200);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rof-01: POST /route/:decisionId/outcome closes the loop for a real decision_id from POST /route", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const routeRes = await fetch(`http://localhost:${port}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "rof-test-1", task_type: "build" }),
    });
    const routeBody = await routeRes.json();
    assert.ok(routeBody.decision_id, "POST /route must return a decision_id");

    const outcomeRes = await fetch(`http://localhost:${port}/route/${routeBody.decision_id}/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "success", actual_cost: 0.42 }),
    });
    assert.equal(outcomeRes.status, 200);
    const outcomeBody = await outcomeRes.json();
    assert.deepEqual(outcomeBody, { ok: true });
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rof-01: POST /route/:decisionId/outcome for an unknown decision_id returns 404, never a crash", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/route/never-existed/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "failure" }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { ok: false, error: "unknown_decision" });
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-rof-01: POST /route/:decisionId/outcome with malformed JSON returns 400, not a crash", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/route/some-id/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-docs-viewer: GET /docs returns the index with links to every doc", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/docs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /href="\/docs\/architecture"/);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-docs-viewer: GET /docs/:slug renders a real doc, including a live Mermaid diagram", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/docs/architecture`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Heimdall Architecture/);
    assert.match(body, /<pre class="mermaid">/);
    assert.match(body, /\/vendor\/mermaid\.min\.js/);
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-docs-viewer: GET /docs/:slug for an unknown slug returns 404, never a crash", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/docs/nonexistent`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "unknown_doc");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-docs-viewer: GET /vendor/mermaid.min.js serves the real vendored bundle locally, no redirect/CDN", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/vendor/mermaid.min.js`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const body = await res.text();
    assert.ok(body.length > 100_000, "expected the real mermaid bundle, not a stub");
  } finally {
    server.close();
    store.close();
  }
});

test("hdl-docs-viewer: GET / (dashboard) links to /docs, and existing routes are unaffected (additive only)", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const dashRes = await fetch(`http://localhost:${port}/`);
    const dashBody = await dashRes.text();
    assert.match(dashBody, /href="\/docs"/);

    const lanesRes = await fetch(`http://localhost:${port}/lanes`);
    assert.equal(lanesRes.status, 200);
  } finally {
    server.close();
    store.close();
  }
});

// hdl-bp-04: setBackoffPolicy — mirrors setRoutingStrategy's exact
// validation/return shape (structured {error, allowed_policies} on an
// invalid name, never throws). No HTTP route exists for this yet
// (hdl-bp-05), so — like setLaneOverride above — it's tested by calling the
// shared function directly, independent of any HTTP server.

test("hdl-bp-04: setBackoffPolicy is independently callable without an HTTP server and persists the setting", () => {
  const store = new StateStore(":memory:");
  try {
    const result = setBackoffPolicy(store, "progressive");
    assert.deepEqual(result, { ok: true, active: "progressive" });
    assert.equal(store.getSetting("backoff_policy"), "progressive");
  } finally {
    store.close();
  }
});

test("hdl-bp-04: setBackoffPolicy returns {ok: false, error: 'invalid_policy', allowed_policies} for an unknown name, and does not throw", () => {
  const store = new StateStore(":memory:");
  try {
    const result = setBackoffPolicy(store, "not-a-real-policy");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_policy");
      assert.deepEqual(result.allowed_policies.sort(), ["exponential", "progressive", "static"]);
    }
    assert.equal(store.getSetting("backoff_policy"), null, "an invalid name must not be persisted");
  } finally {
    store.close();
  }
});

test("hdl-bp-04: setBackoffPolicy rejects a non-string name the same way (returns invalid_policy, does not throw)", () => {
  const store = new StateStore(":memory:");
  try {
    const result = setBackoffPolicy(store, 42);
    assert.equal(result.ok, false);
  } finally {
    store.close();
  }
});
