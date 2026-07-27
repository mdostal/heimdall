import type { LaneRegistry } from "./lane-registry.js";
import type { StateStore } from "./state-store.js";
import type { LanePipeline } from "./lane-pipeline.js";

export interface Route {
  lane_id: string;
  provider: string;
  credential_ref: string;
}

/**
 * RouteTable is responsible for handing out valid routes.
 * It confirms routes are usable (live) before handing them out by forcing a
 * concurrent refresh of all lanes, returning all that are 'up'.
 * 
 * "Validate the full ladder (claude -> codex -> gemini) then run all lanes concurrently, not swap-only."
 */
export class RouteTable {
  constructor(
    private readonly registry: LaneRegistry,
    private readonly store: StateStore,
    private readonly pipelines: Map<string, LanePipeline>,
  ) {}

  /**
   * Forces a concurrent active refresh of all configured lanes and returns
   * the routes (mapping lane to credential_ref) that are currently healthy ('up').
   */
  async getConfirmedRoutes(): Promise<Route[]> {
    const lanes = this.registry.list();

    // Run all lanes concurrently, not swap-only.
    await Promise.all(
      lanes.map(async (lane) => {
        const pipeline = this.pipelines.get(lane.lane_id);
        if (pipeline) {
          try {
            await pipeline.refresh(lane);
          } catch (err) {
            console.error(`[RouteTable] Failed to refresh lane ${lane.lane_id}:`, err);
          }
        }
      })
    );

    const routes: Route[] = [];
    for (const lane of lanes) {
      const status = this.store.getCurrentStatus(lane.lane_id);
      if (status && status.status === "up") {
        routes.push({
          lane_id: lane.lane_id,
          provider: lane.provider,
          credential_ref: lane.credential_ref,
        });
      }
    }

    return routes;
  }
}
