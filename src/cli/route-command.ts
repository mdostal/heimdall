import { getLaneHealths, parseTaskType, RouteRequest, RouteSelector } from "../core/route-selector.js";
import { PolicyLoader } from "../core/routing/policy-loader.js";
import { RouteLedger } from "../core/routing/route-ledger.js";
import type { LaneRegistry } from "../core/lane-registry.js";
import type { StateStore } from "../core/state-store.js";

export function runRouteCommand(args: string[], registry: LaneRegistry, store: StateStore): void {
  let taskId = "";
  let taskType = "";
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
      taskType = arg.split("=")[1];
    } else if (arg === "--task-type") {
      taskType = args[++i];
    } else if (arg.startsWith("--estimated-cost=")) {
      estimatedCost = Number(arg.split("=")[1]);
    } else if (arg === "--estimated-cost") {
      estimatedCost = Number(args[++i]);
    }
  }

  if (!taskId || !taskType) {
    console.error("Usage: heimdall route --task-type=<type> --task-id=<id> [--estimated-cost=<cost>] [--json]");
    process.exit(1);
  }

  const parsedTaskType = parseTaskType(taskType);
  if (!parsedTaskType) {
    console.error(`Invalid task-type: ${taskType}`);
    process.exit(1);
  }

  const request: RouteRequest = {
    task_id: taskId,
    task_type: parsedTaskType,
    estimated_cost: estimatedCost,
  };

  const policy = PolicyLoader.load();
  const ledger = new RouteLedger(process.env.HEIMDALL_DB_PATH ?? ":memory:");
  const routeSelector = new RouteSelector(policy, ledger);
  const laneHealth = getLaneHealths(registry, store);

  const result = routeSelector.select(request, laneHealth);

  if (jsonMode) {
    console.error(JSON.stringify(result, null, 2));
    console.log(result.chosen_lane ?? "null");
  } else {
    console.log(`Chosen Lane: ${result.chosen_lane ?? "None"}`);
    console.log(`Rationale: ${result.rationale}`);
  }
}
