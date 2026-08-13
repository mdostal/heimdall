// The default routing strategy (hdl-rs-02) — a verbatim extraction of the
// RUNTIME_PRIORITY table and ranking logic that used to live inline in
// route-selector.ts's getAvailableRoute. Zero behavior change: same table,
// same tie-break (lane_id, alphabetical) when two candidates share a rank.

import type { Lane } from "../lane-registry.js";
import type { TaskType } from "../route-selector.js";
import type { RoutingStrategy } from "./types.js";

const RUNTIME_PRIORITY: Record<TaskType, readonly string[]> = {
  planning: ["claude", "gemini", "codex", "kimi"],
  build: ["codex", "claude", "gemini", "kimi"],
  review: ["claude", "codex", "gemini", "kimi"],
};

function runtimeRank(taskType: TaskType, runtime: string): number {
  const rank = RUNTIME_PRIORITY[taskType].indexOf(runtime);
  return rank === -1 ? RUNTIME_PRIORITY[taskType].length : rank;
}

export class PriorityStrategy implements RoutingStrategy {
  readonly name = "priority";

  selectRoute(taskType: TaskType, candidates: readonly Lane[]): Lane | null {
    const sorted = [...candidates].sort((a, b) => {
      const runtimeDelta = runtimeRank(taskType, a.provider) - runtimeRank(taskType, b.provider);
      return runtimeDelta === 0 ? a.lane_id.localeCompare(b.lane_id) : runtimeDelta;
    });
    return sorted[0] ?? null;
  }
}
