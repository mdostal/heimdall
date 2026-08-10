import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMcpServer,
  listLaneToolsDescriptor,
  callLanesListTool,
  LANES_LIST_TOOL_NAME,
} from "./mcp-server.js";
import { getLaneStatuses } from "./http-server.js";
import { LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import { EnvCredentialSource } from "../core/credential-source.js";
import { LANE_STATUS_VALUES } from "../core/status-model.js";

function registryWithOneConfiguredLane(): LaneRegistry {
  return new LaneRegistry(
    [{ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" }],
    new EnvCredentialSource({ CLAUDE_TOKEN: "secret" }),
  );
}

test("listLaneToolsDescriptor exposes exactly one tool: heimdall.lanes.list", () => {
  const tools = listLaneToolsDescriptor();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, LANES_LIST_TOOL_NAME);
  assert.equal(tools[0].name, "heimdall.lanes.list");
});

test("callLanesListTool returns lane data identical to getLaneStatuses (no duplicated logic)", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");

  const result = callLanesListTool(registry, store);
  const expected = getLaneStatuses(registry, store);

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, expected);
  store.close();
});

test("callLanesListTool returns lane statuses matching the LaneRouterContract shape", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const result = callLanesListTool(registry, store);
  const lanes = JSON.parse(result.content[0].text);

  assert.equal(lanes.length, 1);
  assert.ok(LANE_STATUS_VALUES.includes(lanes[0].status));
  store.close();
});

test("createMcpServer returns a connectable Server instance (smoke test)", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const server = createMcpServer(registry, store);
  assert.ok(server);
  assert.equal(typeof server.connect, "function");
  store.close();
});

test("no lanes configured -> empty result, not an error", () => {
  const registry = new LaneRegistry([], new EnvCredentialSource({}));
  const store = new StateStore(":memory:");
  const result = callLanesListTool(registry, store);
  assert.deepEqual(JSON.parse(result.content[0].text), []);
  store.close();
});

test("callRouteSelectionTool returns RouteResult JSON text", async () => {
  const { callRouteSelectionTool } = await import("../mcp/route-tool.js");
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const result = callRouteSelectionTool({ task_id: "t1", task_type: "build" }, registry, store);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.decision_id);
  assert.ok("chosen_lane" in parsed);
});
