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

// hdl-or-04: an explicit lane.priority replaces the table-driven rank
// OUTRIGHT (override-wins-outright, mirroring manual_override's precedence
// shape) rather than blending with it — a lane with no priority set is
// ranked byte-identically to pre-hdl-or-04 behavior. Comparable directly on
// the same 0..N scale runtimeRank produces (documented, intentional — see
// hdl-openrouter-signals/docs/design-discussion.md).
function effectiveRank(taskType: TaskType, lane: Lane): number {
  return lane.priority ?? runtimeRank(taskType, lane.provider);
}

export class PriorityStrategy implements RoutingStrategy {
  readonly name = "priority";

  selectRoute(taskType: TaskType, candidates: readonly Lane[]): Lane | null {
    const sorted = [...candidates].sort((a, b) => {
      const rankDelta = effectiveRank(taskType, a) - effectiveRank(taskType, b);
      return rankDelta === 0 ? a.lane_id.localeCompare(b.lane_id) : rankDelta;
    });
    return sorted[0] ?? null;
  }
}
