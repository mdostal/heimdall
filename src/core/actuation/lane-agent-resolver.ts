// LaneAgentResolver — maps a lane_id to its Multica agent ID(s) (hda-02).
// Interface-first so a v2 DiscoveryLaneAgentResolver (matching provider+model
// against GET /api/agents?workspace_id=...) can drop in later without
// touching MulticaControlAdapter. Static now, discovery-ready.

export interface LaneAgentResolver {
  resolve(laneId: string): string[];
}

/**
 * Reads contiguous HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS (comma-separated),
 * keyed to the same HEIMDALL_LANE_<N>_ID declarations lane-registry.ts
 * reads — stops at the first gap in numbering, same convention.
 */
export function loadStaticLaneAgentMappings(env: NodeJS.ProcessEnv = process.env): Map<string, string[]> {
  const mappings = new Map<string, string[]>();
  for (let i = 1; ; i++) {
    const laneId = env[`HEIMDALL_LANE_${i}_ID`];
    if (!laneId) break;

    const raw = env[`HEIMDALL_LANE_${i}_MULTICA_AGENT_IDS`];
    if (raw) {
      const agentIds = raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      if (agentIds.length > 0) {
        mappings.set(laneId, agentIds);
      }
    }
  }
  return mappings;
}

export class StaticLaneAgentResolver implements LaneAgentResolver {
  private readonly mappings: Map<string, string[]>;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.mappings = loadStaticLaneAgentMappings(env);
  }

  resolve(laneId: string): string[] {
    return this.mappings.get(laneId) ?? [];
  }
}
