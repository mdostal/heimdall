// GET /lanes — fixture-backed proof of the LaneRouterContract shape.
// See .pHive/epics/lane-health-status/stories/lhs-01-service-skeleton-fixture-http.yaml
//
// No real credential loading, signal detection, or state storage yet — this
// is Vertical Slice 1 (see .pHive/epics/lane-health-status/docs/vertical-plan.md).
// Slice 2 (lhs-02) replaces FIXTURE_LANES with real state-store-backed data.

import { createServer, type Server } from "node:http";
import type { LaneStatus } from "../core/status-model.js";

export const FIXTURE_LANES: readonly LaneStatus[] = [
  {
    lane_id: "claude@mathew.dostal",
    provider: "claude",
    status: "up",
    reset_at: null,
    reason: null,
    last_updated: "2026-07-25T00:00:00.000Z",
    signal_source: "passive",
  },
  {
    lane_id: "codex",
    provider: "codex",
    status: "degraded",
    reset_at: null,
    reason: "elevated latency reported on public status page",
    last_updated: "2026-07-25T00:00:00.000Z",
    signal_source: "public_status",
  },
];

export function getLaneStatuses(): readonly LaneStatus[] {
  return FIXTURE_LANES;
}

export function createHttpServer(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/lanes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getLaneStatuses()));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const port = Number(process.env.PORT ?? 4870);
  createHttpServer().listen(port, () => {
    console.log(`heimdall dev server listening on http://localhost:${port}`);
  });
}
