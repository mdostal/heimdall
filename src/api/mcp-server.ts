// MCP surface for the LaneRouterContract (REQ-05) — Pantheon-mode interface.
// Calls the same shared getLaneStatuses() core function as http-server.ts
// and cli.ts; no duplicated query logic. Synchronous request/response per
// tool call, per the LaneRouterContract's binding contract (never
// fire-and-forget) — see .pHive/planning/architecture.md.
//
// Tool logic (listLaneToolsDescriptor/callLanesListTool) is factored out
// from the SDK's Server/transport wiring specifically so it's unit-testable
// without spinning up a stdio transport.
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
import { buildLaneRegistry, getLaneStatuses, type GetConfirmedRoutesFn } from "./http-server.js";
import { StateStore } from "../core/state-store.js";
import type { LaneRegistry } from "../core/lane-registry.js";

export const LANES_LIST_TOOL_NAME = "heimdall.lanes.list";
export const ROUTES_GET_TOOL_NAME = "heimdall.routes.get";

export function listLaneToolsDescriptor(hasRoutesTool: boolean = false) {
  const tools = [
    {
      name: LANES_LIST_TOOL_NAME,
      description:
        "List current lane availability (up/down/out_of_credit/degraded) and why/when for unhealthy ones.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ];
  if (hasRoutesTool) {
    tools.push({
      name: ROUTES_GET_TOOL_NAME,
      description:
        "Get all confirmed-live routes (mappings from lane to token source reference). Forces a concurrent refresh of all lanes.",
      inputSchema: { type: "object" as const, properties: {} },
    });
  }
  return tools;
}

export function callLanesListTool(registry: LaneRegistry, store: StateStore) {
  const lanes = getLaneStatuses(registry, store);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(lanes) }],
  };
}

export async function callRoutesGetTool(getConfirmedRoutes: GetConfirmedRoutesFn) {
  const routes = await getConfirmedRoutes();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(routes) }],
  };
}

export function createMcpServer(
  registry: LaneRegistry,
  store: StateStore,
  getConfirmedRoutes?: GetConfirmedRoutesFn,
): Server {
  const server = new Server(
    { name: "heimdall", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listLaneToolsDescriptor(!!getConfirmedRoutes),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === LANES_LIST_TOOL_NAME) {
      return callLanesListTool(registry, store);
    }
    if (request.params.name === ROUTES_GET_TOOL_NAME && getConfirmedRoutes) {
      return await callRoutesGetTool(getConfirmedRoutes);
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  });

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
