// Shared routing-strategy contract (hdl-rs-02). Each strategy picks (or
// declines to pick) one lane from an already-filtered candidate list —
// candidacy filtering (credential resolved, override-aware sensed status;
// see route-selector.ts's getAvailableRoute) is a single shared concern
// upstream of every strategy, not duplicated inside each one.

import type { Lane } from "../lane-registry.js";
import type { TaskType } from "../route-selector.js";

export interface RoutingStrategy {
  readonly name: string;
  selectRoute(taskType: TaskType, candidates: readonly Lane[]): Lane | null;
}
