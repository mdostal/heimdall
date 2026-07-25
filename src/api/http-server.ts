// GET /lanes — now backed by real credential loading + SQLite state storage
// (REQ-07 + architecture.md's data model), replacing lhs-01's hardcoded
// fixture. Status values are still placeholders (down/unconfigured for every
// lane) — no real signal detection yet; that's lhs-03f.
// See .pHive/epics/lane-health-status/stories/lhs-02-credential-loading-state-storage.yaml

import { createServer, type Server } from "node:http";
import { EnvCredentialSource } from "../core/credential-source.js";
import { loadLaneDeclarations, LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import type { LaneStatus } from "../core/status-model.js";

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

export function createHttpServer(registry: LaneRegistry, store: StateStore): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/lanes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getLaneStatuses(registry, store)));
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
