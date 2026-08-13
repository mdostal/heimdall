// GET /lanes — now backed by real credential loading + SQLite state storage
// (REQ-07 + architecture.md's data model), replacing lhs-01's hardcoded
// fixture. Status values are still placeholders (down/unconfigured for every
// lane) — no real signal detection yet; that's lhs-03f.
// See .pHive/epics/lane-health-status/stories/lhs-02-credential-loading-state-storage.yaml

import { createServer, type Server } from "node:http";
import { EnvCredentialSource } from "../core/credential-source.js";
import { loadLaneDeclarations, LaneRegistry } from "../core/lane-registry.js";
import { getAvailableRoute, parseTaskType } from "../core/route-selector.js";
import { StateStore, type ManualOverride } from "../core/state-store.js";
import type { LaneStatus } from "../core/status-model.js";
import { renderDashboardHtml } from "./ui/dashboard.js";
import { appendLane, deriveCredentialRef, laneIdAlreadyDeclared } from "../core/env-file.js";

const DEFAULT_ENV_FILE_PATH = ".env";

/** Collects and JSON-parses a request body. Shared by every mutation route (override, reset-at, add-lane). */
function readJsonBody(req: import("node:http").IncomingMessage): Promise<{ ok: true; data: unknown } | { ok: false }> {
  return new Promise((resolve) => {
    let rawBody = "";
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      try {
        resolve({ ok: true, data: JSON.parse(rawBody || "{}") });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}

/**
 * GET /lanes' response shape — LaneStatus plus the hdl-lo-01 manual override
 * and hdl-lm-02's credential_configured, so a UI/API consumer never needs a
 * second request to know any of them. credential_configured is a boolean
 * ONLY — the raw secret is never serialized here or anywhere else in this
 * codebase (REQ-07 invariant).
 */
export interface LaneStatusWithOverride extends LaneStatus {
  manual_override: ManualOverride;
  credential_configured: boolean;
  manual_reset_at: string | null;
}

const VALID_OVERRIDE_STATES = new Set(["enabled", "disabled", "auto"]);

export function buildLaneRegistry(env: NodeJS.ProcessEnv = process.env): LaneRegistry {
  return new LaneRegistry(loadLaneDeclarations(env), new EnvCredentialSource(env));
}

export function getLaneStatuses(registry: LaneRegistry, store: StateStore): LaneStatusWithOverride[] {
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
  return store.getAllCurrentStatuses().map((status) => ({
    ...status,
    manual_override: store.getManualOverride(status.lane_id),
    credential_configured: registry.get(status.lane_id)?.credential != null,
    manual_reset_at: store.getManualResetAt(status.lane_id),
  }));
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
  envFilePath: string = DEFAULT_ENV_FILE_PATH,
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

    // Read-only live-status dashboard (hdl-ui-01) — first vertical slice of
    // the standalone-mode UI requirement (has_ui: true). Pure consumer of
    // GET /lanes below; adds no new backend query logic.
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderDashboardHtml());
      return;
    }

    if (req.method === "GET" && req.url === "/lanes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getLaneStatuses(registry, store)));
      return;
    }

    // hdl-lm-01: add a new lane — writes a HEIMDALL_LANE_<N>_* block to the
    // local .env (see src/core/env-file.ts). Does NOT restart the process —
    // loadLaneDeclarations() only runs at boot, so the new lane is inert
    // until the operator restarts (see the response's restart_command).
    if (req.method === "POST" && req.url === "/lanes") {
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const input = body.data as { lane_id?: unknown; provider?: unknown; model?: unknown; token?: unknown };
        const missing = (["lane_id", "provider", "model", "token"] as const).find(
          (field) => typeof input[field] !== "string" || input[field] === "",
        );
        if (missing) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "missing_field", field: missing }));
          return;
        }
        const laneId = input.lane_id as string;

        if (registry.get(laneId) || laneIdAlreadyDeclared(envFilePath, laneId)) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "lane_already_declared", lane_id: laneId }));
          return;
        }

        const credentialRef = deriveCredentialRef(laneId);
        appendLane(envFilePath, {
          lane_id: laneId,
          provider: input.provider as string,
          model: input.model as string,
          credential_ref: credentialRef,
          token: input.token as string,
        });

        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            lane_id: laneId,
            credential_ref: credentialRef,
            restart_required: true,
            restart_command: "npm run dev",
          }),
        );
      });
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

    // hdl-lo-01: manual lane override — routes through the SAME
    // ControlAdapter.reconcile() decision as automatic status-driven
    // actuation (see MulticaControlAdapter's desiredEnabled computation),
    // not a separate mechanism. Takes effect on the next reconcile tick
    // (<=5s, same latency as the existing suspect-lane cadence).
    const overrideMatch = req.method === "POST" && req.url?.match(/^\/lanes\/([^/]+)\/override$/);
    if (overrideMatch) {
      const laneId = decodeURIComponent(overrideMatch[1]);
      if (!registry.get(laneId)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown_lane", lane_id: laneId }));
        return;
      }

      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }

        const state = (body.data as { state?: unknown }).state;
        if (typeof state !== "string" || !VALID_OVERRIDE_STATES.has(state)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: "invalid_override_state",
              allowed_states: [...VALID_OVERRIDE_STATES],
            }),
          );
          return;
        }

        const value: ManualOverride = state === "auto" ? null : (state as "enabled" | "disabled");
        store.setManualOverride(laneId, value);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ lane_id: laneId, manual_override: value }));
      });
      return;
    }

    // hdl-lm-03: manual reset_at ("change the times") — mirrors the
    // override route exactly. Scheduling-only: InProcessScheduler prefers
    // this over the sensed reset_at (hdl-rar-01); does not touch
    // ControlAdapter/ReconcileContext/Argus.
    const resetAtMatch = req.method === "POST" && req.url?.match(/^\/lanes\/([^/]+)\/reset-at$/);
    if (resetAtMatch) {
      const laneId = decodeURIComponent(resetAtMatch[1]);
      if (!registry.get(laneId)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown_lane", lane_id: laneId }));
        return;
      }

      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }

        const resetAt = (body.data as { reset_at?: unknown }).reset_at;
        if (resetAt === null) {
          store.setManualResetAt(laneId, null);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ lane_id: laneId, manual_reset_at: null }));
          return;
        }

        if (typeof resetAt !== "string") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_reset_at", message: "reset_at must be an ISO-8601 string or null" }));
          return;
        }
        const parsedMs = Date.parse(resetAt);
        if (Number.isNaN(parsedMs)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_reset_at", message: "reset_at is not a valid ISO-8601 timestamp" }));
          return;
        }
        if (parsedMs <= Date.now()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "reset_at_in_the_past", message: "reset_at must be in the future" }));
          return;
        }

        store.setManualResetAt(laneId, resetAt);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ lane_id: laneId, manual_reset_at: resetAt }));
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
