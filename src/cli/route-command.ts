// CLI surface for the scored routing contract (hdl-rr-03, restored against
// the refactored routing-strategies interface) — a thin wrapper around the
// same getScoredRoute() shared function POST /route and MCP route_selection
// use. No duplicated scoring/ledger/experiment-arm logic.

import { getScoredRoute, reportRouteOutcome, parseTaskType } from "../core/route-selector.js";
import type { LaneRegistry } from "../core/lane-registry.js";
import type { StateStore } from "../core/state-store.js";

export function runRouteCommand(args: string[], registry: LaneRegistry, store: StateStore): void {
  let taskId = "";
  let rawTaskType = "";
  let estimatedCost: number | undefined;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      jsonMode = true;
    } else if (arg.startsWith("--task-id=")) {
      taskId = arg.split("=")[1];
    } else if (arg === "--task-id") {
      taskId = args[++i];
    } else if (arg.startsWith("--task-type=")) {
      rawTaskType = arg.split("=")[1];
    } else if (arg === "--task-type") {
      rawTaskType = args[++i];
    } else if (arg.startsWith("--estimated-cost=")) {
      estimatedCost = Number(arg.split("=")[1]);
    } else if (arg === "--estimated-cost") {
      estimatedCost = Number(args[++i]);
    }
  }

  if (!taskId || !rawTaskType) {
    console.error("Usage: heimdall route --task-type=<type> --task-id=<id> [--estimated-cost=<cost>] [--json]");
    process.exit(1);
  }

  const taskType = parseTaskType(rawTaskType);
  if (!taskType) {
    console.error(`Invalid task-type: ${rawTaskType}`);
    process.exit(1);
  }

  const result = getScoredRoute({ task_id: taskId, task_type: taskType, estimated_cost: estimatedCost }, registry, store);

  if (jsonMode) {
    console.error(JSON.stringify(result, null, 2));
    console.log(result.chosen_lane ?? "null");
  } else {
    console.log(`Chosen Lane: ${result.chosen_lane ?? "None"}`);
    console.log(`Rationale: ${result.rationale}`);
  }
}

// hdl-rof-02: thin wrapper around the same reportRouteOutcome() shared
// function POST /route/:decisionId/outcome and MCP
// heimdall.route.reportOutcome use. No duplicated ledger logic.
export function runRouteOutcomeCommand(args: string[]): void {
  let decisionId = "";
  let outcome: string | undefined;
  let actualCost: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--decision-id=")) {
      decisionId = arg.split("=")[1];
    } else if (arg === "--decision-id") {
      decisionId = args[++i];
    } else if (arg.startsWith("--outcome=")) {
      outcome = arg.split("=")[1];
    } else if (arg === "--outcome") {
      outcome = args[++i];
    } else if (arg.startsWith("--actual-cost=")) {
      actualCost = Number(arg.split("=")[1]);
    } else if (arg === "--actual-cost") {
      actualCost = Number(args[++i]);
    }
  }

  if (!decisionId) {
    console.error("Usage: heimdall route-outcome --decision-id=<id> [--outcome=<value>] [--actual-cost=<cost>]");
    process.exit(1);
  }

  const result = reportRouteOutcome({ decisionId, outcome, actualCost });
  if (!result.ok) {
    console.error(`Failed to report outcome: ${result.error}`);
    process.exit(1);
  }
  console.log(`Outcome recorded for decision ${decisionId}.`);
}
