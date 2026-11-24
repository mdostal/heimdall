// heimdall#142 slice 3: the level gate over HTTP and MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHttpServer } from "./http-server.js";
import { callRouteSelectionTool } from "./mcp-server.js";
import { LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import { useRouteLedgerPath, useRoutePolicyPath } from "../core/route-selector.js";
import { DEFAULT_POLICY_PATH } from "../core/routing/policy-loader.js";

useRouteLedgerPath(":memory:");

const LEVELS_POLICY = `
levels:
  models:
    claude-opus-5-5: premium
    claude-sonnet-5-5: standard
work_classes:
  planning:
    levels: [premium, standard]
`;

async function withServer(
  extraPolicy: string,
  fn: (port: number, store: StateStore, registry: LaneRegistry) => Promise<void>,
): Promise<void> {
  const policyPath = join(mkdtempSync(join(tmpdir(), "heimdall-levels-api-")), "routing-policy.yaml");
  writeFileSync(policyPath, readFileSync(DEFAULT_POLICY_PATH, "utf8") + extraPolicy, "utf8");
  useRoutePolicyPath(policyPath);
  const registry = new LaneRegistry(
    [
      { lane_id: "opus", provider: "claude", credential_ref: "OPUS_TOKEN", model: "claude-opus-5-5", priority: 5 },
      { lane_id: "sonnet", provider: "claude", credential_ref: "SONNET_TOKEN", model: "claude-sonnet-5-5", priority: 0 },
    ],
    { resolve: () => "secret" },
  );
  const store = new StateStore(":memory:");
  const now = new Date().toISOString();
  for (const lane_id of ["opus", "sonnet"]) {
    store.recordStatus({ lane_id, status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: now });
  }
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await fn((server.address() as AddressInfo).port, store, registry);
  } finally {
    server.close();
    store.close();
    useRoutePolicyPath(undefined);
    rmSync(dirname(policyPath), { recursive: true, force: true });
  }
}

function exhaustOpus(store: StateStore, resetsAt: string): void {
  store.recordLimit(
    "opus",
    { kind: "weekly_model:claude-opus-5-5", scope: "model", model: "claude-opus-5-5", state: "exhausted", used_percent: 100, resets_at: resetsAt, reason: "limit" },
    "passive",
    new Date().toISOString(),
  );
}

test("levels API: GET /available-route routes build to premium and opt-in planning to standard", async () => {
  await withServer(LEVELS_POLICY, async (port) => {
    const build = await (await fetch(`http://localhost:${port}/available-route?task-type=build`)).json();
    assert.equal(build.lane_id, "opus");
    assert.equal(build.level, "premium");
    const planning = await (await fetch(`http://localhost:${port}/available-route?task-type=planning`)).json();
    assert.equal(planning.lane_id, "sonnet");
    assert.equal(planning.level, "standard");
    // A floor work class keeps planning on premium.
    const release = await (await fetch(`http://localhost:${port}/available-route?task-type=planning&work-class=release`)).json();
    assert.equal(release.lane_id, "opus");
  });
});

test("levels API: with premium exhausted, GET /available-route answers 404 verdict queue with resets_at", async () => {
  await withServer(LEVELS_POLICY, async (port, store) => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    exhaustOpus(store, resetsAt);
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "no_available_route");
    assert.equal(body.task_type, "build");
    assert.equal(body.verdict, "queue");
    assert.equal(body.resets_at, resetsAt);
    assert.deepEqual(body.allowed_levels, ["premium"]);
    assert.ok(body.level_withheld.some((e: { lane_id: string; reason: string }) => e.lane_id === "sonnet" && e.reason === "level_not_allowed"));
  });
});

test("levels API: POST /route and the MCP route_selection tool carry the queue verdict and work_class", async () => {
  await withServer(LEVELS_POLICY, async (port, store, registry) => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    exhaustOpus(store, resetsAt);
    const res = await fetch(`http://localhost:${port}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "levels-1", task_type: "planning", work_class: "code" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.chosen_lane, null);
    assert.equal(body.verdict, "queue");
    assert.equal(body.resets_at, resetsAt);
    assert.equal(body.work_class, "code");

    const mcp = JSON.parse(callRouteSelectionTool(registry, store, { task_id: "levels-2", task_type: "planning" }).content[0].text);
    assert.equal(mcp.chosen_lane, "sonnet");
    assert.equal(mcp.chosen_level, "standard");
    const mcpCode = JSON.parse(callRouteSelectionTool(registry, store, { task_id: "levels-3", task_type: "planning", work_class: "code" }).content[0].text);
    assert.equal(mcpCode.verdict, "queue");
    assert.equal(mcpCode.resets_at, resetsAt);
  });
});

test("levels API: an invalid level config makes routing answer 503 routing_policy_unavailable", async () => {
  await withServer(`work_classes:\n  build:\n    levels: [standard]\n`, async (port) => {
    const res = await fetch(`http://localhost:${port}/available-route?task-type=build`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "routing_policy_unavailable");
    const post = await fetch(`http://localhost:${port}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "levels-bad", task_type: "build" }),
    });
    assert.equal(post.status, 503);
  });
});
