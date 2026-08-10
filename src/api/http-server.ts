// GET /lanes — now backed by real credential loading + SQLite state storage
// (REQ-07 + architecture.md's data model), replacing lhs-01's hardcoded
// fixture. Status values are still placeholders (down/unconfigured for every
// lane) — no real signal detection yet; that's lhs-03f.
// See .pHive/epics/lane-health-status/stories/lhs-02-credential-loading-state-storage.yaml

import { createServer, type Server } from "node:http";
import { EnvCredentialSource } from "../core/credential-source.js";
import { loadLaneDeclarations, LaneRegistry } from "../core/lane-registry.js";
import { getAvailableRoute, parseTaskType, RouteSelector, getLaneHealths, type RouteRequest } from "../core/route-selector.js";
import { StateStore } from "../core/state-store.js";
import type { LaneStatus } from "../core/status-model.js";
import { PolicyLoader } from "../core/routing/policy-loader.js";
import { RouteLedger } from "../core/routing/route-ledger.js";

export function buildLaneRegistry(env: NodeJS.ProcessEnv = process.env): LaneRegistry {
  return new LaneRegistry(loadLaneDeclarations(env), new EnvCredentialSource(env));
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
  routeSelector?: RouteSelector,
): Server {
  return createServer((req, res) => {
    // Liveness alias — distinct from /lanes on purpose: a monitor (e.g.
    // Salus) should be able to confirm the process is up and serving HTTP
    // without that check depending on lane declarations or StateStore reads.
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "GET" && req.url === "/lanes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getLaneStatuses(registry, store)));
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/available-route")) {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/available-route") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      const taskType = parseTaskType(url.searchParams.get("task-type"));
      if (!taskType) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "invalid_task_type",
            allowed_task_types: ["planning", "build", "review"],
          }),
        );
        return;
      }

      const route = getAvailableRoute(taskType, registry, store);
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no_available_route", task_type: taskType }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(route));
      return;
    }

    if (req.method === "POST" && req.url === "/route") {
      if (!routeSelector) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "route_selector_not_configured" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body);
          if (!payload.task_id || !payload.task_type) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "missing_task_id_or_task_type" }));
            return;
          }
          const taskType = parseTaskType(payload.task_type);
          if (!taskType) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: "invalid_task_type",
                allowed_task_types: ["planning", "build", "review"],
              }),
            );
            return;
          }
          const request: RouteRequest = {
            task_id: payload.task_id,
            task_type: taskType,
            estimated_cost: payload.estimated_cost,
          };
          const laneHealth = getLaneHealths(registry, store);
          const result = routeSelector.select(request, laneHealth);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json_body" }));
        }
      });
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
  
  const policy = PolicyLoader.load();
  const ledger = new RouteLedger(process.env.HEIMDALL_DB_PATH ?? ":memory:");
  const routeSelector = new RouteSelector(policy, ledger);

  createHttpServer(registry, store, undefined, routeSelector).listen(port, () => {
    console.log(`heimdall dev server listening on http://localhost:${port}`);
  });
}
