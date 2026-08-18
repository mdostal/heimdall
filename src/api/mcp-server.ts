// MCP surface for the LaneRouterContract (REQ-05) — Pantheon-mode interface.
// Calls the same shared getLaneStatuses()/setLaneOverride()/setLaneResetAt()/
// addLane() core functions as http-server.ts and cli.ts; no duplicated
// query or validation logic. Synchronous request/response per tool call,
// per the LaneRouterContract's binding contract (never fire-and-forget) —
// see .pHive/planning/architecture.md.
//
// hdl-mcp-lane-tools: extends the original heimdall.lanes.list tool with
// heimdall.lanes.override, heimdall.lanes.setResetAt, and heimdall.lanes.add
// — the last piece of docs/decisions/DEC-hdl-reason-aware-recovery.md item 3
// ("expose the same capability as tools for agents to exercise/test through
// Heimdall"). Validation failures (unknown lane, invalid state, etc.) return
// structured {ok: false, error, ...} text content, matching
// heimdall.lanes.list's existing never-throws-on-empty-data philosophy and
// REQ-07's down/unconfigured-is-data-not-exception pattern. Only a
// genuinely unknown TOOL NAME throws (unchanged from the original
// single-tool behavior).
//
// Tool logic (listLaneToolsDescriptor/call*Tool) is factored out from the
// SDK's Server/transport wiring specifically so it's unit-testable without
// spinning up a stdio transport.
//
// NOTE: @modelcontextprotocol/sdk pulls in @hono/node-server (used for its
// HTTP/SSE transports, which this file does not use — only the stdio
// transport below). `npm audit` currently flags a moderate Windows-only
// path-traversal advisory in that transitive dependency; since we never
// exercise Hono's static-file serving, this doesn't affect Heimdall's
// runtime behavior. Revisit if the SDK bumps its own dependency.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildLaneRegistry,
  getLaneStatuses,
  setLaneOverride,
  setLaneResetAt,
  addLane,
  setRoutingStrategy,
  type AddLaneInput,
} from "./http-server.js";
import { getActiveRoutingStrategyName, getRoutingStrategyNames, getScoredRoute, reportRouteOutcome, parseTaskType } from "../core/route-selector.js";
import { refreshModelCatalog, getModelCatalog, setModelEnabled } from "../core/model-catalog.js";
import { StateStore } from "../core/state-store.js";
import type { LaneRegistry } from "../core/lane-registry.js";

export const LANES_LIST_TOOL_NAME = "heimdall.lanes.list";
export const LANES_OVERRIDE_TOOL_NAME = "heimdall.lanes.override";
export const LANES_SET_RESET_AT_TOOL_NAME = "heimdall.lanes.setResetAt";
export const LANES_ADD_TOOL_NAME = "heimdall.lanes.add";
export const ROUTING_STRATEGY_GET_TOOL_NAME = "heimdall.routingStrategy.get";
export const ROUTING_STRATEGY_SET_TOOL_NAME = "heimdall.routingStrategy.set";
export const MODELS_LIST_TOOL_NAME = "heimdall.models.list";
export const MODELS_REFRESH_TOOL_NAME = "heimdall.models.refresh";
export const MODELS_SET_ENABLED_TOOL_NAME = "heimdall.models.setEnabled";
export const ROUTE_SELECTION_TOOL_NAME = "route_selection";
export const ROUTE_REPORT_OUTCOME_TOOL_NAME = "heimdall.route.reportOutcome";

const DEFAULT_ENV_FILE_PATH = ".env";

export function listLaneToolsDescriptor() {
  return [
    {
      name: LANES_LIST_TOOL_NAME,
      description:
        "List current lane availability (up/down/out_of_credit/degraded) and why/when for unhealthy ones.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: LANES_OVERRIDE_TOOL_NAME,
      description:
        "Manually enable, disable, or return a lane to automatic (auto) status-driven routing. Routes through the same top-level actuation decision automatic sensing already uses — not a separate mechanism.",
      inputSchema: {
        type: "object" as const,
        properties: {
          lane_id: { type: "string" as const, description: "The lane to set the override on." },
          state: {
            type: "string" as const,
            enum: ["enabled", "disabled", "auto"],
            description: "'auto' clears the override, returning to sensed-status-driven routing.",
          },
          reason: {
            type: "string" as const,
            description: "Optional free-text note for why this lane is overridden. Ignored (never persisted) when state is 'auto'.",
          },
        },
        required: ["lane_id", "state"],
      },
    },
    {
      name: LANES_SET_RESET_AT_TOOL_NAME,
      description:
        "Manually set (or clear, with null) a lane's expected recovery time. Wins over the automatically-sensed reset_at when the scheduler decides when to check the lane again.",
      inputSchema: {
        type: "object" as const,
        properties: {
          lane_id: { type: "string" as const, description: "The lane to set the manual reset_at on." },
          reset_at: {
            type: "string" as const,
            description: "An ISO-8601 timestamp in the future, or null to clear a previously-set manual reset_at.",
            nullable: true,
          },
        },
        required: ["lane_id", "reset_at"],
      },
    },
    {
      name: LANES_ADD_TOOL_NAME,
      description:
        "Declare a new lane, writing it to the local .env file. Does NOT restart the process — the new lane is inert until Heimdall is restarted (the response names the exact restart command).",
      inputSchema: {
        type: "object" as const,
        properties: {
          lane_id: { type: "string" as const },
          provider: { type: "string" as const },
          model: { type: "string" as const },
          token: { type: "string" as const, description: "The lane's credential — stored locally in .env, never returned by any Heimdall API." },
        },
        required: ["lane_id", "provider", "model", "token"],
      },
    },
    {
      name: ROUTING_STRATEGY_GET_TOOL_NAME,
      description:
        "Get the active routing strategy (priority | round-robin | off) and the full list of available strategies. There is exactly one active strategy, global across all lanes.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: ROUTING_STRATEGY_SET_TOOL_NAME,
      description:
        "Set the active routing strategy. 'off' means /available-route never picks a lane — callers fall back to GET /lanes to decide manually.",
      inputSchema: {
        type: "object" as const,
        properties: {
          strategy: { type: "string" as const, description: "One of the names returned by heimdall.routingStrategy.get's 'available' list." },
        },
        required: ["strategy"],
      },
    },
    {
      name: MODELS_LIST_TOOL_NAME,
      description:
        "List the live, per-installation model catalog — what models can actually be called right now, per provider, and whether each is enabled. Answers 'what are my available models to call' directly, instead of guessing/hardcoding a model name that may be deprecated.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: { type: "string" as const, description: "Optional — filter to one provider (e.g. 'gemini'). Omit for the full catalog." },
        },
      },
    },
    {
      name: MODELS_REFRESH_TOOL_NAME,
      description:
        "Fetch each configured lane's provider's live model list and update the local catalog. Newly-seen models get a default enabled/disabled state (recency heuristic); previously-seen models' enabled state is never touched by a refresh.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: MODELS_SET_ENABLED_TOOL_NAME,
      description:
        "Enable or disable one model for a provider. Overrides the recency-heuristic default; survives future refreshes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: { type: "string" as const },
          model_id: { type: "string" as const },
          enabled: { type: "boolean" as const },
        },
        required: ["provider", "model_id", "enabled"],
      },
    },
    {
      name: ROUTE_SELECTION_TOOL_NAME,
      description:
        "Get a scored route recommendation for a task — weighted candidate scoring, deterministic A/B experiment arm, generated rationale, and a decision ledger entry. Always uses the 'scored' strategy regardless of the globally active routing strategy (the same contract as POST /route).",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string" as const, description: "Caller-supplied identifier — also the deterministic key for experiment-arm assignment." },
          task_type: { type: "string" as const, enum: ["planning", "build", "review"] },
          estimated_cost: { type: "number" as const },
        },
        required: ["task_id", "task_type"],
      },
    },
    {
      name: ROUTE_REPORT_OUTCOME_TOOL_NAME,
      description:
        "Report what actually happened with a routing decision returned by route_selection/POST /route — closes the loop the decision ledger was designed for.",
      inputSchema: {
        type: "object" as const,
        properties: {
          decision_id: { type: "string" as const, description: "The decision_id returned by route_selection." },
          outcome: { type: "string" as const, description: "Free-form outcome label, e.g. 'success' or 'failure'." },
          actual_cost: { type: "number" as const },
        },
        required: ["decision_id"],
      },
    },
  ];
}

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function callLanesListTool(registry: LaneRegistry, store: StateStore) {
  return textResult(getLaneStatuses(registry, store));
}

export function callLaneOverrideTool(registry: LaneRegistry, store: StateStore, args: unknown) {
  const input = (args ?? {}) as { lane_id?: unknown; state?: unknown; reason?: unknown };
  const laneId = typeof input.lane_id === "string" ? input.lane_id : "";
  return textResult(setLaneOverride(registry, store, laneId, input.state, input.reason));
}

export function callLaneSetResetAtTool(registry: LaneRegistry, store: StateStore, args: unknown) {
  const input = (args ?? {}) as { lane_id?: unknown; reset_at?: unknown };
  const laneId = typeof input.lane_id === "string" ? input.lane_id : "";
  return textResult(setLaneResetAt(registry, store, laneId, input.reset_at ?? null));
}

export function callAddLaneTool(registry: LaneRegistry, envFilePath: string, args: unknown) {
  return textResult(addLane(registry, envFilePath, (args ?? {}) as AddLaneInput));
}

export function callRoutingStrategyGetTool(store: StateStore) {
  return textResult({
    active: getActiveRoutingStrategyName(store),
    available: getRoutingStrategyNames(),
  });
}

export function callRoutingStrategySetTool(store: StateStore, args: unknown) {
  const input = (args ?? {}) as { strategy?: unknown };
  const result = setRoutingStrategy(store, input.strategy);
  const { ok: _ok, ...wire } = result;
  return textResult(wire);
}

export function callModelsListTool(store: StateStore, args: unknown) {
  const input = (args ?? {}) as { provider?: unknown };
  const provider = typeof input.provider === "string" ? input.provider : undefined;
  return textResult(getModelCatalog(store, provider));
}

export function callModelsRefreshTool(store: StateStore, registry: LaneRegistry, fetchImpl?: typeof fetch) {
  return refreshModelCatalog(store, registry, fetchImpl).then((result) => textResult(result));
}

export function callModelsSetEnabledTool(store: StateStore, args: unknown) {
  const input = (args ?? {}) as { provider?: unknown; model_id?: unknown; enabled?: unknown };
  const provider = typeof input.provider === "string" ? input.provider : "";
  const modelId = typeof input.model_id === "string" ? input.model_id : "";
  const enabled = input.enabled === true;
  const result = setModelEnabled(store, provider, modelId, enabled);
  const { ok: _ok, ...wire } = result;
  return textResult(wire);
}

export function callRouteSelectionTool(registry: LaneRegistry, store: StateStore, args: unknown) {
  const input = (args ?? {}) as { task_id?: unknown; task_type?: unknown; estimated_cost?: unknown };
  const taskId = typeof input.task_id === "string" ? input.task_id : "";
  const taskType = parseTaskType(typeof input.task_type === "string" ? input.task_type : null);
  if (!taskId || !taskType) {
    return textResult({ ok: false, error: "invalid_request", required: ["task_id", "task_type"], allowed_task_types: ["planning", "build", "review"] });
  }
  const estimatedCost = typeof input.estimated_cost === "number" ? input.estimated_cost : undefined;
  return textResult(getScoredRoute({ task_id: taskId, task_type: taskType, estimated_cost: estimatedCost }, registry, store));
}

export function callRouteReportOutcomeTool(args: unknown) {
  const input = (args ?? {}) as { decision_id?: unknown; outcome?: unknown; actual_cost?: unknown };
  const decisionId = typeof input.decision_id === "string" ? input.decision_id : "";
  if (!decisionId) {
    return textResult({ ok: false, error: "invalid_request", required: ["decision_id"] });
  }
  const outcome = typeof input.outcome === "string" ? input.outcome : undefined;
  const actualCost = typeof input.actual_cost === "number" ? input.actual_cost : undefined;
  return textResult(reportRouteOutcome({ decisionId, outcome, actualCost }));
}

/**
 * Builds the tool-name -> handler dispatch table. Exported separately from
 * createMcpServer so the dispatch behavior (in particular: throws for a
 * genuinely unknown tool name, never throws for a known tool's validation
 * failure) is directly unit-testable without spinning up the SDK's Server/
 * transport machinery.
 */
type ToolResult = ReturnType<typeof callLanesListTool>;

export function buildToolDispatch(
  registry: LaneRegistry,
  store: StateStore,
  envFilePath: string = DEFAULT_ENV_FILE_PATH,
  fetchImpl?: typeof fetch,
): Record<string, (args: unknown) => ToolResult | Promise<ToolResult>> {
  return {
    [LANES_LIST_TOOL_NAME]: () => callLanesListTool(registry, store),
    [LANES_OVERRIDE_TOOL_NAME]: (args) => callLaneOverrideTool(registry, store, args),
    [LANES_SET_RESET_AT_TOOL_NAME]: (args) => callLaneSetResetAtTool(registry, store, args),
    [LANES_ADD_TOOL_NAME]: (args) => callAddLaneTool(registry, envFilePath, args),
    [ROUTING_STRATEGY_GET_TOOL_NAME]: () => callRoutingStrategyGetTool(store),
    [ROUTING_STRATEGY_SET_TOOL_NAME]: (args) => callRoutingStrategySetTool(store, args),
    [MODELS_LIST_TOOL_NAME]: (args) => callModelsListTool(store, args),
    [MODELS_REFRESH_TOOL_NAME]: () => callModelsRefreshTool(store, registry, fetchImpl),
    [MODELS_SET_ENABLED_TOOL_NAME]: (args) => callModelsSetEnabledTool(store, args),
    [ROUTE_SELECTION_TOOL_NAME]: (args) => callRouteSelectionTool(registry, store, args),
    [ROUTE_REPORT_OUTCOME_TOOL_NAME]: (args) => callRouteReportOutcomeTool(args),
  };
}

/** Looks up and invokes a tool by name against a dispatch table. Throws ONLY for a name with no matching handler — every known tool's own validation failures are returned as structured content instead (see call*Tool above). */
export function dispatchToolCall(
  dispatch: ReturnType<typeof buildToolDispatch>,
  toolName: string,
  args: unknown,
): ToolResult | Promise<ToolResult> {
  const handler = dispatch[toolName];
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return handler(args);
}

export function createMcpServer(
  registry: LaneRegistry,
  store: StateStore,
  envFilePath: string = DEFAULT_ENV_FILE_PATH,
  fetchImpl?: typeof fetch,
): Server {
  const server = new Server(
    { name: "heimdall", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listLaneToolsDescriptor(),
  }));

  const dispatch = buildToolDispatch(registry, store, envFilePath, fetchImpl);
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatchToolCall(dispatch, request.params.name, request.params.arguments),
  );

  return server;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const registry = buildLaneRegistry();
  const store = new StateStore(process.env.HEIMDALL_DB_PATH ?? ":memory:");
  const server = createMcpServer(registry, store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
