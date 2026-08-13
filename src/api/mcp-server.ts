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
import { getActiveRoutingStrategyName, getRoutingStrategyNames } from "../core/route-selector.js";
import { StateStore } from "../core/state-store.js";
import type { LaneRegistry } from "../core/lane-registry.js";

export const LANES_LIST_TOOL_NAME = "heimdall.lanes.list";
export const LANES_OVERRIDE_TOOL_NAME = "heimdall.lanes.override";
export const LANES_SET_RESET_AT_TOOL_NAME = "heimdall.lanes.setResetAt";
export const LANES_ADD_TOOL_NAME = "heimdall.lanes.add";
export const ROUTING_STRATEGY_GET_TOOL_NAME = "heimdall.routingStrategy.get";
export const ROUTING_STRATEGY_SET_TOOL_NAME = "heimdall.routingStrategy.set";

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
  ];
}

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function callLanesListTool(registry: LaneRegistry, store: StateStore) {
  return textResult(getLaneStatuses(registry, store));
}

export function callLaneOverrideTool(registry: LaneRegistry, store: StateStore, args: unknown) {
  const input = (args ?? {}) as { lane_id?: unknown; state?: unknown };
  const laneId = typeof input.lane_id === "string" ? input.lane_id : "";
  return textResult(setLaneOverride(registry, store, laneId, input.state));
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

/**
 * Builds the tool-name -> handler dispatch table. Exported separately from
 * createMcpServer so the dispatch behavior (in particular: throws for a
 * genuinely unknown tool name, never throws for a known tool's validation
 * failure) is directly unit-testable without spinning up the SDK's Server/
 * transport machinery.
 */
export function buildToolDispatch(
  registry: LaneRegistry,
  store: StateStore,
  envFilePath: string = DEFAULT_ENV_FILE_PATH,
): Record<string, (args: unknown) => ReturnType<typeof callLanesListTool>> {
  return {
    [LANES_LIST_TOOL_NAME]: () => callLanesListTool(registry, store),
    [LANES_OVERRIDE_TOOL_NAME]: (args) => callLaneOverrideTool(registry, store, args),
    [LANES_SET_RESET_AT_TOOL_NAME]: (args) => callLaneSetResetAtTool(registry, store, args),
    [LANES_ADD_TOOL_NAME]: (args) => callAddLaneTool(registry, envFilePath, args),
    [ROUTING_STRATEGY_GET_TOOL_NAME]: () => callRoutingStrategyGetTool(store),
    [ROUTING_STRATEGY_SET_TOOL_NAME]: (args) => callRoutingStrategySetTool(store, args),
  };
}

/** Looks up and invokes a tool by name against a dispatch table. Throws ONLY for a name with no matching handler — every known tool's own validation failures are returned as structured content instead (see call*Tool above). */
export function dispatchToolCall(
  dispatch: ReturnType<typeof buildToolDispatch>,
  toolName: string,
  args: unknown,
): ReturnType<typeof callLanesListTool> {
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
): Server {
  const server = new Server(
    { name: "heimdall", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listLaneToolsDescriptor(),
  }));

  const dispatch = buildToolDispatch(registry, store, envFilePath);
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
