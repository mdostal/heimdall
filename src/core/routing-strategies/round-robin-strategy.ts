// Round-robin routing strategy (hdl-rs-02) — cycles through the available
// candidates (sorted by lane_id for determinism) per task type, one lane
// further on each call. Rotation state is in-memory per strategy instance
// and resets on process restart — an accepted tradeoff, matching this
// codebase's existing precedent for exactly this class of state (e.g.
// MulticaControlAdapter's AgentState map, LanePipeline's corroboration map).

import type { Lane } from "../lane-registry.js";
import type { TaskType } from "../route-selector.js";
import type { RoutingStrategy } from "./types.js";

export class RoundRobinStrategy implements RoutingStrategy {
  readonly name = "round-robin";

  private readonly cursorByTaskType = new Map<TaskType, number>();

  selectRoute(taskType: TaskType, candidates: readonly Lane[]): Lane | null {
    if (candidates.length === 0) return null;

    const sorted = [...candidates].sort((a, b) => a.lane_id.localeCompare(b.lane_id));
    const cursor = this.cursorByTaskType.get(taskType) ?? 0;
    const index = cursor % sorted.length;
    this.cursorByTaskType.set(taskType, cursor + 1);
    return sorted[index];
  }
}
