import { LaneStatus } from "../status-model.js";

export interface TaskDescriptor {
  task_type: string;
}

export interface LanePolicy {
  provider?: string;
  lane_id?: string;
  cost: number;
  weight?: number; // Used for splitting traffic/headroom distribution
}

export interface RoutingRule {
  task_types: string[];
  lanes: LanePolicy[];
}

export interface RoutingPolicy {
  rules: RoutingRule[];
  default_rule?: RoutingRule;
}

export interface RankedLane {
  lane_id: string;
  provider: string;
  cost: number;
  weight: number;
}

export class RouteSelector {
  constructor(private policy: RoutingPolicy) {}

  select(statuses: LaneStatus[], task: TaskDescriptor): RankedLane[] {
    // Only route to healthy lanes that are actually emitting (not out_of_credit or down)
    const upLanes = statuses.filter((s) => s.status === "up");
    
    let rule = this.policy.rules.find((r) => r.task_types.includes(task.task_type));
    if (!rule) {
      rule = this.policy.default_rule;
    }

    if (!rule) {
      return [];
    }

    const rankedLanes: RankedLane[] = [];

    for (const status of upLanes) {
      // Find the most specific matching lane policy (lane_id preferred over provider)
      let matchedPolicy = rule.lanes.find((lp) => lp.lane_id === status.lane_id);
      if (!matchedPolicy) {
        matchedPolicy = rule.lanes.find((lp) => lp.provider === status.provider && !lp.lane_id);
      }

      if (matchedPolicy) {
        rankedLanes.push({
          lane_id: status.lane_id,
          provider: status.provider,
          cost: matchedPolicy.cost,
          weight: matchedPolicy.weight ?? 1,
        });
      }
    }

    // Rank: primary sort by cost (ascending), secondary sort by weight (descending)
    // Traffic splitting (headroom) can be done by the caller using weights among lanes with the same cost.
    rankedLanes.sort((a, b) => {
      if (a.cost !== b.cost) {
        return a.cost - b.cost; // Lower cost is better
      }
      return b.weight - a.weight; // Higher weight is better
    });

    return rankedLanes;
  }
}
