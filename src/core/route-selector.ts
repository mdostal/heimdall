import type { LaneRegistry } from "./lane-registry.js";
import type { StateStore } from "./state-store.js";

export const TASK_TYPES = ["planning", "build", "review"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export interface AvailableRoute {
  runtime: string;
  model: string;
  "token-ref": string;
  lane_id: string;
  task_type: TaskType;
  headroom: true;
}

const RUNTIME_PRIORITY: Record<TaskType, readonly string[]> = {
  planning: ["claude", "gemini", "codex", "kimi"],
  build: ["codex", "claude", "gemini", "kimi"],
  review: ["claude", "codex", "gemini", "kimi"],
};

export function parseTaskType(value: string | null): TaskType | null {
  return TASK_TYPES.find((taskType) => taskType === value) ?? null;
}

function runtimeRank(taskType: TaskType, runtime: string): number {
  const rank = RUNTIME_PRIORITY[taskType].indexOf(runtime);
  return rank === -1 ? RUNTIME_PRIORITY[taskType].length : rank;
}

export function getAvailableRoute(
  taskType: TaskType,
  registry: LaneRegistry,
  store: StateStore,
): AvailableRoute | null {
  for (const lane of registry.list()) {
    store.upsertLane({
      lane_id: lane.lane_id,
      provider: lane.provider,
      credential_ref: lane.credential_ref,
    });
  }

  const statuses = new Map(store.getAllCurrentStatuses().map((status) => [status.lane_id, status]));
  const candidates = registry
    .list()
    .filter((lane) => lane.credential !== null)
    .filter((lane) => statuses.get(lane.lane_id)?.status === "up")
    .sort((a, b) => {
      const runtimeDelta = runtimeRank(taskType, a.provider) - runtimeRank(taskType, b.provider);
      return runtimeDelta === 0 ? a.lane_id.localeCompare(b.lane_id) : runtimeDelta;
    });

  const lane = candidates[0];
  if (!lane) return null;

  return {
    runtime: lane.provider,
    model: lane.model,
    "token-ref": lane.credential_ref,
    lane_id: lane.lane_id,
    task_type: taskType,
    headroom: true,
  };
}
