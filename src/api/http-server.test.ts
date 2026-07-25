import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer, getLaneStatuses, FIXTURE_LANES } from "./http-server.js";
import { LANE_STATUS_VALUES, SIGNAL_SOURCES } from "../core/status-model.js";

test("getLaneStatuses returns entries matching the LaneRouterContract shape", () => {
  const lanes = getLaneStatuses();
  assert.ok(Array.isArray(lanes));
  assert.ok(lanes.length > 0);
  for (const lane of lanes) {
    assert.equal(typeof lane.lane_id, "string");
    assert.equal(typeof lane.provider, "string");
    assert.ok(
      LANE_STATUS_VALUES.includes(lane.status),
      `unexpected status: ${lane.status}`,
    );
    assert.ok(lane.reset_at === null || typeof lane.reset_at === "string");
    assert.ok(lane.reason === null || typeof lane.reason === "string");
    assert.equal(typeof lane.last_updated, "string");
    assert.ok(
      SIGNAL_SOURCES.includes(lane.signal_source),
      `unexpected signal_source: ${lane.signal_source}`,
    );
  }
});

test("GET /lanes returns 200 with the fixture lanes as JSON", async () => {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/lanes`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.deepEqual(body, FIXTURE_LANES);
  } finally {
    server.close();
  }
});

test("unknown routes return 404", async () => {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://localhost:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
