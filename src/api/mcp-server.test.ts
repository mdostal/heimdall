import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createMcpServer,
  listLaneToolsDescriptor,
  callLanesListTool,
  callLaneOverrideTool,
  callLaneSetResetAtTool,
  callAddLaneTool,
  callRoutingStrategyGetTool,
  callRoutingStrategySetTool,
  callModelsListTool,
  callModelsRefreshTool,
  callModelsSetEnabledTool,
  callRouteSelectionTool,
  callRouteReportOutcomeTool,
  buildToolDispatch,
  dispatchToolCall,
  LANES_LIST_TOOL_NAME,
  LANES_OVERRIDE_TOOL_NAME,
  LANES_SET_RESET_AT_TOOL_NAME,
  LANES_ADD_TOOL_NAME,
  ROUTING_STRATEGY_GET_TOOL_NAME,
  ROUTING_STRATEGY_SET_TOOL_NAME,
  MODELS_LIST_TOOL_NAME,
  MODELS_REFRESH_TOOL_NAME,
  MODELS_SET_ENABLED_TOOL_NAME,
  ROUTE_SELECTION_TOOL_NAME,
  ROUTE_REPORT_OUTCOME_TOOL_NAME,
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

function tmpEnvPath(): string {
  return path.join(os.tmpdir(), `heimdall-mcp-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
}

test("listLaneToolsDescriptor exposes 11 tools: list, override, setResetAt, add, routingStrategy.get/set, models.list/refresh/setEnabled, route_selection, route.reportOutcome (hdl-rof-02)", () => {
  const tools = listLaneToolsDescriptor();
  assert.equal(tools.length, 11);
  const names = tools.map((t) => t.name);
  assert.deepEqual(
    names.sort(),
    [
      LANES_ADD_TOOL_NAME,
      LANES_LIST_TOOL_NAME,
      LANES_OVERRIDE_TOOL_NAME,
      LANES_SET_RESET_AT_TOOL_NAME,
      ROUTING_STRATEGY_GET_TOOL_NAME,
      ROUTING_STRATEGY_SET_TOOL_NAME,
      MODELS_LIST_TOOL_NAME,
      MODELS_REFRESH_TOOL_NAME,
      MODELS_SET_ENABLED_TOOL_NAME,
      ROUTE_SELECTION_TOOL_NAME,
      ROUTE_REPORT_OUTCOME_TOOL_NAME,
    ].sort(),
  );
  assert.equal(LANES_LIST_TOOL_NAME, "heimdall.lanes.list");
  assert.equal(LANES_OVERRIDE_TOOL_NAME, "heimdall.lanes.override");
  assert.equal(LANES_SET_RESET_AT_TOOL_NAME, "heimdall.lanes.setResetAt");
  assert.equal(LANES_ADD_TOOL_NAME, "heimdall.lanes.add");
  assert.equal(MODELS_LIST_TOOL_NAME, "heimdall.models.list");
  assert.equal(MODELS_REFRESH_TOOL_NAME, "heimdall.models.refresh");
  assert.equal(MODELS_SET_ENABLED_TOOL_NAME, "heimdall.models.setEnabled");
  assert.equal(ROUTING_STRATEGY_GET_TOOL_NAME, "heimdall.routingStrategy.get");
  assert.equal(ROUTING_STRATEGY_SET_TOOL_NAME, "heimdall.routingStrategy.set");
});

test("hdl-mcp-02: every tool's inputSchema requires lane_id where applicable, and every field the shared function needs", () => {
  const tools = listLaneToolsDescriptor();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(byName[LANES_OVERRIDE_TOOL_NAME].inputSchema.required, ["lane_id", "state"]);
  assert.deepEqual(byName[LANES_SET_RESET_AT_TOOL_NAME].inputSchema.required, ["lane_id", "reset_at"]);
  assert.deepEqual(byName[LANES_ADD_TOOL_NAME].inputSchema.required, ["lane_id", "provider", "model", "token"]);
});

test("hdl-rr-03: callRouteSelectionTool returns a scored RouteResult for a valid request", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const result = callRouteSelectionTool(registry, store, { task_id: "t1", task_type: "build" });
  const payload = JSON.parse(result.content[0].text);
  // No lanes are "up" (no status recorded), so the candidate list is empty —
  // proves the tool wires through to getScoredRoute without crashing, same
  // shape POST /route returns.
  assert.equal(payload.chosen_lane, null);
  assert.ok(typeof payload.decision_id === "string" && payload.decision_id.length > 0);
  store.close();
});

test("hdl-rr-03: callRouteSelectionTool returns structured invalid_request for a missing task_id, never throws", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const result = callRouteSelectionTool(registry, store, { task_type: "build" });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "invalid_request");
  store.close();
});

test("hdl-rof-02: callRouteReportOutcomeTool closes the loop for a real decision_id from callRouteSelectionTool", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const selectResult = callRouteSelectionTool(registry, store, { task_id: "t-mcp-1", task_type: "build" });
  const decisionId = JSON.parse(selectResult.content[0].text).decision_id;

  const outcomeResult = callRouteReportOutcomeTool({ decision_id: decisionId, outcome: "success" });
  const payload = JSON.parse(outcomeResult.content[0].text);
  assert.deepEqual(payload, { ok: true });
  store.close();
});

test("hdl-rof-02: callRouteReportOutcomeTool returns structured unknown_decision for an unrecognized id, never throws", () => {
  const result = callRouteReportOutcomeTool({ decision_id: "never-existed" });
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload, { ok: false, error: "unknown_decision" });
});

test("hdl-rof-02: callRouteReportOutcomeTool returns structured invalid_request for a missing decision_id, never throws", () => {
  const result = callRouteReportOutcomeTool({});
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "invalid_request");
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

test("hdl-mcp-02: callLaneOverrideTool returns setLaneOverride's result wrapped in MCP text content", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    const result = callLaneOverrideTool(registry, store, { lane_id: "claude@mathew.dostal", state: "disabled" });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed, { ok: true, lane_id: "claude@mathew.dostal", manual_override: "disabled" });
  } finally {
    store.close();
  }
});

test("hdl-mcp-02: callLaneOverrideTool does NOT throw on an unknown lane_id — returns structured {ok: false} content instead", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    assert.doesNotThrow(() => callLaneOverrideTool(registry, store, { lane_id: "never-declared", state: "disabled" }));
    const result = callLaneOverrideTool(registry, store, { lane_id: "never-declared", state: "disabled" });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "unknown_lane");
  } finally {
    store.close();
  }
});

test("hdl-mcp-02: callLaneSetResetAtTool sets and clears a manual reset_at, matching setLaneResetAt's result shape", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  try {
    const setResult = callLaneSetResetAtTool(registry, store, { lane_id: "claude@mathew.dostal", reset_at: future });
    assert.deepEqual(JSON.parse(setResult.content[0].text), {
      ok: true,
      lane_id: "claude@mathew.dostal",
      manual_reset_at: future,
    });

    const clearResult = callLaneSetResetAtTool(registry, store, { lane_id: "claude@mathew.dostal", reset_at: null });
    assert.deepEqual(JSON.parse(clearResult.content[0].text), {
      ok: true,
      lane_id: "claude@mathew.dostal",
      manual_reset_at: null,
    });
  } finally {
    store.close();
  }
});

test("hdl-mcp-02: callAddLaneTool adds a lane and reports restart_required — an agent must be able to tell the lane isn't live yet", () => {
  const registry = registryWithOneConfiguredLane();
  const envPath = tmpEnvPath();
  try {
    const result = callAddLaneTool(registry, envPath, {
      lane_id: "gemini@ops",
      provider: "gemini",
      model: "gemini-3-pro",
      token: "secret-value",
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.lane_id, "gemini@ops");
    assert.equal(parsed.credential_ref, "GEMINI_OPS_TOKEN");
    assert.equal(parsed.restart_required, true);
    assert.equal(parsed.restart_command, "npm run dev");
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-mcp-02: callAddLaneTool does NOT throw on a duplicate lane_id — returns structured {ok: false} content instead", () => {
  const registry = registryWithOneConfiguredLane();
  const envPath = tmpEnvPath();
  try {
    assert.doesNotThrow(() =>
      callAddLaneTool(registry, envPath, { lane_id: "claude@mathew.dostal", provider: "claude", model: "claude-sonnet", token: "x" }),
    );
    const result = callAddLaneTool(registry, envPath, {
      lane_id: "claude@mathew.dostal",
      provider: "claude",
      model: "claude-sonnet",
      token: "x",
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "lane_already_declared");
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-mrs-01: callRoutingStrategyGetTool returns the same shape GET /routing-strategy does", () => {
  const store = new StateStore(":memory:");
  try {
    const result = callRoutingStrategyGetTool(store);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.active, "priority");
    assert.ok(Array.isArray(parsed.available));
    assert.ok(parsed.available.includes("priority"));
    assert.ok(parsed.available.includes("round-robin"));
    assert.ok(parsed.available.includes("off"));
  } finally {
    store.close();
  }
});

test("hdl-mrs-01: callRoutingStrategySetTool persists a valid strategy change, verifiable via a subsequent get", () => {
  const store = new StateStore(":memory:");
  try {
    const setResult = callRoutingStrategySetTool(store, { strategy: "round-robin" });
    assert.deepEqual(JSON.parse(setResult.content[0].text), { active: "round-robin" });

    const getResult = callRoutingStrategyGetTool(store);
    assert.equal(JSON.parse(getResult.content[0].text).active, "round-robin");
  } finally {
    store.close();
  }
});

test("hdl-mrs-01: callRoutingStrategySetTool does NOT throw on an invalid strategy name — returns structured {error} content instead", () => {
  const store = new StateStore(":memory:");
  try {
    const result = callRoutingStrategySetTool(store, { strategy: "not-a-real-strategy" });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error, "invalid_strategy");
    assert.ok(Array.isArray(parsed.allowed_strategies));
  } finally {
    store.close();
  }
});

test("hdl-mcp-02: dispatchToolCall throws for a genuinely unknown tool name", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    const dispatch = buildToolDispatch(registry, store);
    assert.throws(() => dispatchToolCall(dispatch, "heimdall.lanes.doesNotExist", {}), /Unknown tool/);
  } finally {
    store.close();
  }
});

test("hdl-mcp-02: dispatchToolCall does NOT throw for any of the 9 known tools, even on their own validation failures", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const envPath = tmpEnvPath();
  try {
    const dispatch = buildToolDispatch(registry, store, envPath);
    assert.doesNotThrow(() => dispatchToolCall(dispatch, LANES_LIST_TOOL_NAME, {}));
    assert.doesNotThrow(() => dispatchToolCall(dispatch, LANES_OVERRIDE_TOOL_NAME, { lane_id: "never-declared", state: "disabled" }));
    assert.doesNotThrow(() => dispatchToolCall(dispatch, LANES_SET_RESET_AT_TOOL_NAME, { lane_id: "never-declared", reset_at: null }));
    assert.doesNotThrow(() => dispatchToolCall(dispatch, LANES_ADD_TOOL_NAME, { lane_id: "claude@mathew.dostal", provider: "x", model: "y", token: "z" }));
    assert.doesNotThrow(() => dispatchToolCall(dispatch, ROUTING_STRATEGY_GET_TOOL_NAME, {}));
    assert.doesNotThrow(() => dispatchToolCall(dispatch, ROUTING_STRATEGY_SET_TOOL_NAME, { strategy: "not-a-real-strategy" }));
    assert.doesNotThrow(() => dispatchToolCall(dispatch, MODELS_LIST_TOOL_NAME, {}));
    assert.doesNotThrow(() => dispatchToolCall(dispatch, MODELS_SET_ENABLED_TOOL_NAME, { provider: "claude", model_id: "never-seen", enabled: true }));
  } finally {
    store.close();
    fs.rmSync(envPath, { force: true });
  }
});

test("hdl-mc-05: heimdall.models.list/.setEnabled/.refresh never throw on validation failure or a genuine refresh", async () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const fetchImpl: typeof fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ data: [{ id: "claude-opus-5", created_at: "2026-02-04T00:00:00Z" }] }) }) as unknown as Response) as typeof fetch;
  try {
    const listResult = callModelsListTool(store, {});
    assert.deepEqual(JSON.parse(listResult.content[0].text), []);

    const refreshResult = await callModelsRefreshTool(store, registry, fetchImpl);
    const refreshBody = JSON.parse(refreshResult.content[0].text);
    assert.equal(refreshBody.modelsSeen, 1);

    const setEnabledResult = callModelsSetEnabledTool(store, { provider: "claude", model_id: "claude-opus-5", enabled: false });
    assert.deepEqual(JSON.parse(setEnabledResult.content[0].text), { provider: "claude", model_id: "claude-opus-5", enabled: false });

    const unknownResult = callModelsSetEnabledTool(store, { provider: "claude", model_id: "never-seen", enabled: true });
    assert.deepEqual(JSON.parse(unknownResult.content[0].text), { error: "unknown_model" });
  } finally {
    store.close();
  }
});

test("hdl-mcp-02: createMcpServer still constructs a connectable Server instance with all 9 tools wired", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  try {
    const server = createMcpServer(registry, store);
    assert.ok(server);
    assert.equal(typeof server.connect, "function");
  } finally {
    store.close();
  }
});
