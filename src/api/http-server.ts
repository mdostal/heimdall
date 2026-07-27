// GET /lanes — now backed by real credential loading + SQLite state storage
// (REQ-07 + architecture.md's data model), replacing lhs-01's hardcoded
// fixture. Status values are still placeholders (down/unconfigured for every
// lane) — no real signal detection yet; that's lhs-03f.
// See .pHive/epics/lane-health-status/stories/lhs-02-credential-loading-state-storage.yaml

import { createServer, type Server } from "node:http";
import { buildCredentialSource } from "../core/credential-source.js";
import { loadLaneDeclarations, LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import type { LaneStatus } from "../core/status-model.js";

export function buildLaneRegistry(env: NodeJS.ProcessEnv = process.env): LaneRegistry {
  return new LaneRegistry(loadLaneDeclarations(env), buildCredentialSource(env));
}

export function getLaneStatuses(registry: LaneRegistry, store: StateStore): LaneStatus[] {
  // Ensure every declared lane is present in the store (REQ-07: a lane with a
  // missing/invalid credential is still known — it just resolves to
  // down/unconfigured via StateStore's "no status row yet" fallback).
  for (const lane of registry.list()) {
    store.upsertLane({
      lane_id: lane.lane_id,
      provider: lane.provider,
      credential_ref: lane.credential_ref,
    });
  }
  return store.getAllCurrentStatuses();
}

/**
 * Optional: triggers a real refresh for one lane on demand — the endpoint
 * MulticaAutopilotScheduler's dispatched agent calls (see hdl-05's decision
 * record). Omitted (undefined) in tests/contexts that don't need it — the
 * POST /lanes/:laneId/refresh route responds 501 when no refresh function
 * is wired, rather than silently 404ing (distinguishes "not implemented
 * here" from "no such route").
 */
export type RefreshLaneFn = (laneId: string) => Promise<void>;

export function createHttpServer(
  registry: LaneRegistry,
  store: StateStore,
  refreshLane?: RefreshLaneFn,
): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/lanes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getLaneStatuses(registry, store)));
      return;
    }

    const refreshMatch = req.method === "POST" && req.url?.match(/^\/lanes\/([^/]+)\/refresh$/);
    if (refreshMatch) {
      const laneId = decodeURIComponent(refreshMatch[1]);
      if (!refreshLane) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "refresh_not_configured" }));
        return;
      }
      if (!registry.get(laneId)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown_lane", lane_id: laneId }));
        return;
      }
      refreshLane(laneId)
        .then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ lane_id: laneId, refreshed: true }));
        })
        .catch((err) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "refresh_failed", message: String(err) }));
        });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const registry = buildLaneRegistry();
  const store = new StateStore(process.env.HEIMDALL_DB_PATH ?? ":memory:");
  const port = Number(process.env.PORT ?? 4870);
  createHttpServer(registry, store).listen(port, () => {
    console.log(`heimdall dev server listening on http://localhost:${port}`);
  });
}
