import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { getLaneHealths, parseTaskType, RouteRequest, RouteSelector } from "../core/route-selector.js";
import { PolicyLoader } from "../core/routing/policy-loader.js";
import { RouteLedger } from "../core/routing/route-ledger.js";
import type { LaneRegistry } from "../core/lane-registry.js";
import type { StateStore } from "../core/state-store.js";

export const ROUTE_SELECTION_TOOL_NAME = "route_selection";
export const ROUTE_OUTCOME_TOOL_NAME = "report_route_outcome";

export function routeOutcomeToolDescriptor() {
  return {
    name: ROUTE_OUTCOME_TOOL_NAME,
    description: "Report the actual outcome and cost of a routing decision back to the route ledger.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string" },
        outcome: { type: "string" },
        actual_cost: { type: "number" },
        metadata: {
          type: "object",
          additionalProperties: true
        }
      },
      required: ["decision_id"]
    }
  };
}

export function callRouteOutcomeTool(
  params: any
) {
  const decisionId = params.decision_id;
  if (!decisionId) {
    throw new Error("Missing decision_id");
  }

  const ledger = new RouteLedger(process.env.HEIMDALL_DB_PATH ?? ":memory:");
  const ok = ledger.reportOutcome({
    decisionId,
    outcome: params.outcome,
    actualCost: params.actual_cost,
    metadata: params.metadata,
  });

  if (!ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found", message: "Decision ID not found" }) }],
      isError: true,
    };
  }

  const entry = ledger.getDecision(decisionId);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(entry) }]
  };
}

export function routeSelectionToolDescriptor() {
  return {
    name: ROUTE_SELECTION_TOOL_NAME,
    description: "Select the optimal LLM lane for a given task based on routing policy and lane health.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        task_type: { type: "string", enum: ["planning", "build", "review"] },
        estimated_cost: { type: "number" }
      },
      required: ["task_id", "task_type"]
    }
  };
}

export function callRouteSelectionTool(
  params: any,
  registry: LaneRegistry,
  store: StateStore
) {
  const taskId = params.task_id;
  const taskType = parseTaskType(params.task_type);
  if (!taskType) {
    throw new Error(`Invalid task_type: ${params.task_type}`);
  }

  const request: RouteRequest = {
    task_id: taskId,
    task_type: taskType,
    estimated_cost: params.estimated_cost
  };

  const policy = PolicyLoader.load();
  const ledger = new RouteLedger(process.env.HEIMDALL_DB_PATH ?? ":memory:");
  const routeSelector = new RouteSelector(policy, ledger);
  const laneHealth = getLaneHealths(registry, store);

  const result = routeSelector.select(request, laneHealth);
  
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }]
  };
}
