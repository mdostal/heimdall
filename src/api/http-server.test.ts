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
