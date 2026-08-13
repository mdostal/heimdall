import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer, getLaneStatuses } from "./http-server.js";
import { LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import { EnvCredentialSource } from "../core/credential-source.js";
import { LANE_STATUS_VALUES, SIGNAL_SOURCES } from "../core/status-model.js";
import { LanePipeline, claudeAdapters } from "../core/lane-pipeline.js";

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
    });
    assert.equal(JSON.stringify(body).includes("secret-codex"), false);
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
    assert.doesNotMatch(body, /https?:\/\/(?!localhost)/, "no external network requests (CDN scripts/styles etc.)");
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
