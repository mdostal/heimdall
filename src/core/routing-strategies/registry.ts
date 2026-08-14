// The one seam a new routing strategy plugs into (hdl-rs-02) — add a file
// implementing RoutingStrategy, register it here, touch nothing else.

import type { RoutingStrategy } from "./types.js";
import { PriorityStrategy } from "./priority-strategy.js";
import { RoundRobinStrategy } from "./round-robin-strategy.js";
import { OffStrategy } from "./off-strategy.js";
import { ScoredStrategy } from "./scored-strategy.js";

export const DEFAULT_ROUTING_STRATEGY_NAME = "priority";

export function createRoutingStrategyRegistry(): Record<string, RoutingStrategy> {
  return {
    priority: new PriorityStrategy(),
    "round-robin": new RoundRobinStrategy(),
    scored: new ScoredStrategy(),
    off: new OffStrategy(),
  };
}
