// GET /lanes — now backed by real credential loading + SQLite state storage
// (REQ-07 + architecture.md's data model), replacing lhs-01's hardcoded
// fixture. Status values are still placeholders (down/unconfigured for every
// lane) — no real signal detection yet; that's lhs-03f.
// See .pHive/epics/lane-health-status/stories/lhs-02-credential-loading-state-storage.yaml

import { createServer, type Server } from "node:http";
import { EnvCredentialSource } from "../core/credential-source.js";
import { loadLaneDeclarations, LaneRegistry } from "../core/lane-registry.js";
import {
  getAvailableRoute,
  getScoredRoute,
  reportRouteOutcome,
  parseTaskType,
  getActiveRoutingStrategyName,
  getRoutingStrategyNames,
  ROUTING_STRATEGY_SETTING_KEY,
} from "../core/route-selector.js";
import { StateStore, resolveDefaultDbPath, type ManualOverride } from "../core/state-store.js";
import type { LaneStatus } from "../core/status-model.js";
import { renderDashboardHtml } from "./ui/dashboard.js";
import { DOC_ENTRIES, getDocBySlug, renderDocMarkdown, renderDocsIndexHtml, renderDocPageHtml } from "./ui/docs-viewer.js";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLane, deriveCredentialRef, laneIdAlreadyDeclared } from "../core/env-file.js";
import { refreshModelCatalog, getModelCatalog, setModelEnabled } from "../core/model-catalog.js";
import { NoHealthyAccountsAvailableError, type RotationController } from "../core/rotation-controller.js";
import { renderMetrics } from "./metrics.js";
import type { JsonValue } from "../core/routing/route-ledger.js";
import { PolicyLoader } from "../core/routing/policy-loader.js";

const DEFAULT_ENV_FILE_PATH = ".env";

// hdl-docs-viewer: resolved once at module load, not per-request.
// docsRepoRoot assumes cwd === repo root, true for every existing entrypoint
// (npm run dev/cli/mcp already assume this for .env loading) — the
// standalone desktop app wrapper sets this explicitly when it bundles docs/
// alongside the compiled sidecar. mermaidBundlePath uses createRequire so it
// resolves correctly regardless of node_modules hoisting/layout, not a
// hardcoded relative path.
const docsRepoRoot = process.env.HEIMDALL_REPO_ROOT ?? process.cwd();
const mermaidBundlePath = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");

// hdl-icon-reconciliation: the icon-set PNGs live under a Tauri resource
// dir that's a SIBLING of (not nested inside) the Node app's own bundled
// resource dir (see app/src-tauri/tauri.conf.json's bundle.resources: both
// "resources/heimdall" -> "heimdall" and "resources/icon-sets" ->
// "icon-sets" map directly under Resources/, not one inside the other) --
// so docsRepoRoot/HEIMDALL_REPO_ROOT can't reach them. Same env-var-
// override-with-dev-fallback pattern as docsRepoRoot itself: the desktop
// app sets HEIMDALL_ICON_SETS_ROOT explicitly; headless dev/CLI usage
// falls back to the real path in this git checkout.
const iconSetsRoot =
  process.env.HEIMDALL_ICON_SETS_ROOT ?? join(process.cwd(), "app", "src-tauri", "resources", "icon-sets");

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
 * codebase (REQ-07 invariant). model and credential_ref (hdl-or-03) let a
 * consumer group lanes that share a gateway credential (e.g. multiple
 * OpenRouter routes) — credential_ref is the env-var NAME the secret lives
 * under, not the secret itself, same non-sensitive category as
 * credential_configured already established. priority (hdl-or-04) surfaces
 * an active HEIMDALL_LANE_<N>_PRIORITY override so it's never a silent
 * behavior change — null when unset.
 */
export interface LaneStatusWithOverride extends LaneStatus {
  manual_override: ManualOverride;
  override_reason: string | null;
  credential_configured: boolean;
  manual_reset_at: string | null;
  model: string;
  credential_ref: string;
  priority: number | null;
}

const VALID_OVERRIDE_STATES = new Set(["enabled", "disabled", "auto"]);

// hdl-mcp-01: shared mutation functions — extracted from the HTTP routes'
// former inline logic so both the HTTP layer AND the MCP tools (mcp-server.ts)
// call ONE implementation each, mirroring getLaneStatuses's existing role.
// Discriminated results, never exceptions, matching REQ-07's
// data-not-exception philosophy — lets every caller (HTTP status code, or
// an MCP tool's structured content) translate the same result its own way.

export type SetOverrideResult =
  | { ok: true; lane_id: string; manual_override: ManualOverride; override_reason: string | null }
  | { ok: false; error: "unknown_lane"; lane_id: string }
  | { ok: false; error: "invalid_override_state"; allowed_states: string[] }
  | { ok: false; error: "invalid_reason"; message: string };

export function setLaneOverride(
  registry: LaneRegistry,
  store: StateStore,
  laneId: string,
  rawState: unknown,
  rawReason?: unknown,
): SetOverrideResult {
  if (!registry.get(laneId)) {
    return { ok: false, error: "unknown_lane", lane_id: laneId };
  }
  if (typeof rawState !== "string" || !VALID_OVERRIDE_STATES.has(rawState)) {
    return { ok: false, error: "invalid_override_state", allowed_states: [...VALID_OVERRIDE_STATES] };
  }
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
    return { ok: false, error: "invalid_reason", message: "reason must be a string or null" };
  }
  const value: ManualOverride = rawState === "auto" ? null : (rawState as "enabled" | "disabled");
  const reason = typeof rawReason === "string" && rawReason.trim() !== "" ? rawReason : null;
  store.setManualOverride(laneId, value, reason);
  return { ok: true, lane_id: laneId, manual_override: value, override_reason: store.getOverrideReason(laneId) };
}

export type SetResetAtResult =
  | { ok: true; lane_id: string; manual_reset_at: string | null }
  | { ok: false; error: "unknown_lane"; lane_id: string }
  | { ok: false; error: "invalid_reset_at"; message: string }
  | { ok: false; error: "reset_at_in_the_past"; message: string };

export function setLaneResetAt(
  registry: LaneRegistry,
  store: StateStore,
  laneId: string,
  rawResetAt: unknown,
): SetResetAtResult {
  if (!registry.get(laneId)) {
    return { ok: false, error: "unknown_lane", lane_id: laneId };
  }
  if (rawResetAt === null) {
    store.setManualResetAt(laneId, null);
    return { ok: true, lane_id: laneId, manual_reset_at: null };
  }
  if (typeof rawResetAt !== "string") {
    return { ok: false, error: "invalid_reset_at", message: "reset_at must be an ISO-8601 string or null" };
  }
  const parsedMs = Date.parse(rawResetAt);
  if (Number.isNaN(parsedMs)) {
    return { ok: false, error: "invalid_reset_at", message: "reset_at is not a valid ISO-8601 timestamp" };
  }
  if (parsedMs <= Date.now()) {
    return { ok: false, error: "reset_at_in_the_past", message: "reset_at must be in the future" };
  }
  store.setManualResetAt(laneId, rawResetAt);
  return { ok: true, lane_id: laneId, manual_reset_at: rawResetAt };
}

export interface AddLaneInput {
  lane_id?: unknown;
  provider?: unknown;
  model?: unknown;
  token?: unknown;
}

export type AddLaneResult =
  | { ok: true; lane_id: string; credential_ref: string; restart_required: true; restart_command: string }
  | { ok: false; error: "missing_field"; field: string }
  | { ok: false; error: "lane_already_declared"; lane_id: string };

export function addLane(
  registry: LaneRegistry,
  envFilePath: string,
  input: AddLaneInput,
): AddLaneResult {
  const missing = (["lane_id", "provider", "model", "token"] as const).find(
    (field) => typeof input[field] !== "string" || input[field] === "",
  );
  if (missing) {
    return { ok: false, error: "missing_field", field: missing };
  }
  const laneId = input.lane_id as string;

  if (registry.get(laneId) || laneIdAlreadyDeclared(envFilePath, laneId)) {
    return { ok: false, error: "lane_already_declared", lane_id: laneId };
  }

  const credentialRef = deriveCredentialRef(laneId);
  appendLane(envFilePath, {
    lane_id: laneId,
    provider: input.provider as string,
    model: input.model as string,
    credential_ref: credentialRef,
    token: input.token as string,
  });

  return {
    ok: true,
    lane_id: laneId,
    credential_ref: credentialRef,
    restart_required: true,
    restart_command: "npm run dev",
  };
}

export type SetRoutingStrategyResult =
  | { ok: true; active: string }
  | { ok: false; error: "invalid_strategy"; allowed_strategies: string[] };

export function setRoutingStrategy(store: StateStore, rawName: unknown): SetRoutingStrategyResult {
  const allowedStrategies = getRoutingStrategyNames();
  if (typeof rawName !== "string" || !allowedStrategies.includes(rawName)) {
    return { ok: false, error: "invalid_strategy", allowed_strategies: allowedStrategies };
  }
  store.setSetting(ROUTING_STRATEGY_SETTING_KEY, rawName);
  return { ok: true, active: rawName };
}

// hdl-unified-dashboard: dashboard visual theme, persisted the same way
// routing_strategy is (a global settings-table key, mirrors
// ROUTING_STRATEGY_SETTING_KEY/setRoutingStrategy exactly). Mission
// Control is the default per operator direction during the UI-redesign
// synthesis — the CSS itself also defaults to it (bare :root, no
// [data-theme] override needed), so an unset setting and an explicit
// "mission-control" setting render byte-identically.
export const THEME_SETTING_KEY = "dashboard_theme";
export const DASHBOARD_THEMES = ["mission-control", "harbor-watch", "terminal"] as const;
export const DEFAULT_DASHBOARD_THEME = "mission-control";

export function getActiveTheme(store: StateStore): string {
  const stored = store.getSetting(THEME_SETTING_KEY);
  return stored && (DASHBOARD_THEMES as readonly string[]).includes(stored) ? stored : DEFAULT_DASHBOARD_THEME;
}

export type SetThemeResult =
  | { ok: true; active: string }
  | { ok: false; error: "invalid_theme"; allowed_themes: string[] };

export function setTheme(store: StateStore, rawName: unknown): SetThemeResult {
  if (typeof rawName !== "string" || !(DASHBOARD_THEMES as readonly string[]).includes(rawName)) {
    return { ok: false, error: "invalid_theme", allowed_themes: [...DASHBOARD_THEMES] };
  }
  store.setSetting(THEME_SETTING_KEY, rawName);
  return { ok: true, active: rawName };
}

// hdl-desktop-icon-settings: which of the 3 bundled app-icon concepts the
// desktop shell should use. Persisted here (same settings-table pattern)
// so it's a single source of truth the Rust sidecar reads on startup --
// this Node service has no way to reach into the Tauri process directly,
// and the dashboard must keep working identically headless or wrapped, so
// the preference lives on the server side, not in Tauri-only IPC. Watchtower
// is the operator-chosen default (2026-08-18, same synthesis message that
// picked Mission Control as the default theme).
export const ICON_SETTING_KEY = "desktop_icon";
export const DESKTOP_ICONS = ["watchtower", "routing-lanes", "signal-horn"] as const;
export const DEFAULT_DESKTOP_ICON = "watchtower";

export function getActiveIcon(store: StateStore): string {
  const stored = store.getSetting(ICON_SETTING_KEY);
  return stored && (DESKTOP_ICONS as readonly string[]).includes(stored) ? stored : DEFAULT_DESKTOP_ICON;
}

export type SetIconResult =
  | { ok: true; active: string }
  | { ok: false; error: "invalid_icon"; allowed_icons: string[] };

export function setIcon(store: StateStore, rawName: unknown): SetIconResult {
  if (typeof rawName !== "string" || !(DESKTOP_ICONS as readonly string[]).includes(rawName)) {
    return { ok: false, error: "invalid_icon", allowed_icons: [...DESKTOP_ICONS] };
  }
  store.setSetting(ICON_SETTING_KEY, rawName);
  return { ok: true, active: rawName };
}

// hdl-ao-07: whether the operator has dismissed the dashboard's "get
// started" agent-onboarding panel (the install curl one-liner + `heimdall
// agent init`). Same settings-table persistence as THEME_SETTING_KEY/
// ICON_SETTING_KEY -- server-side, not localStorage, so the panel's
// collapsed state is consistent whether the dashboard is loaded via a plain
// browser or the desktop app's webview (both hit the same HTTP server).
// Unset defaults to false (shown/expanded) so a first-time visitor with no
// stored setting sees the panel.
export const AGENT_ONBOARDING_DISMISSED_KEY = "agent_onboarding_dismissed";

export function getAgentOnboardingDismissed(store: StateStore): boolean {
  return store.getSetting(AGENT_ONBOARDING_DISMISSED_KEY) === "true";
}

export type SetAgentOnboardingDismissedResult =
  | { ok: true; dismissed: boolean }
  | { ok: false; error: "invalid_dismissed" };

export function setAgentOnboardingDismissed(store: StateStore, rawValue: unknown): SetAgentOnboardingDismissedResult {
  if (typeof rawValue !== "boolean") {
    return { ok: false, error: "invalid_dismissed" };
  }
  store.setSetting(AGENT_ONBOARDING_DISMISSED_KEY, rawValue ? "true" : "false");
  return { ok: true, dismissed: rawValue };
}

export function buildLaneRegistry(env: NodeJS.ProcessEnv = process.env): LaneRegistry {
  return new LaneRegistry(loadLaneDeclarations(env), new EnvCredentialSource(env));
}

// hdl-rr-04: rotation status/action for one provider — never returns the
// resolved credential (ActiveClaudeAccount.token), matching every other
// credential-handling path in this codebase.
export type RotationStatusResult =
  | { ok: true; active_lane_id: string }
  | { ok: false; error: "unknown_provider" }
  | { ok: false; error: "no_healthy_accounts" };

export function getRotationStatus(rotationControllers: Map<string, RotationController> | undefined, provider: string): RotationStatusResult {
  const controller = rotationControllers?.get(provider);
  if (!controller) return { ok: false, error: "unknown_provider" };
  try {
    return { ok: true, active_lane_id: controller.getActiveAccount().lane_id };
  } catch (error) {
    if (error instanceof NoHealthyAccountsAvailableError) return { ok: false, error: "no_healthy_accounts" };
    throw error;
  }
}

export function rotateProvider(rotationControllers: Map<string, RotationController> | undefined, provider: string): RotationStatusResult {
  const controller = rotationControllers?.get(provider);
  if (!controller) return { ok: false, error: "unknown_provider" };
  try {
    const account = controller.rotateToNextHealthy();
    return { ok: true, active_lane_id: account.lane_id };
  } catch (error) {
    if (error instanceof NoHealthyAccountsAvailableError) return { ok: false, error: "no_healthy_accounts" };
    throw error;
  }
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
  return store.getAllCurrentStatuses().map((status) => {
    const declared = registry.get(status.lane_id);
    return {
      ...status,
      manual_override: store.getManualOverride(status.lane_id),
      override_reason: store.getOverrideReason(status.lane_id),
      credential_configured: declared?.credential != null,
      manual_reset_at: store.getManualResetAt(status.lane_id),
      model: declared?.model ?? status.provider,
      credential_ref: declared?.credential_ref ?? "",
      priority: declared?.priority ?? null,
    };
  });
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
  fetchImpl?: typeof fetch,
  rotationControllers?: Map<string, RotationController>,
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

    // hdl-ot-03: Heimdall's own metrics, entirely local — Prometheus text
    // format so any OTEL/Prometheus-compatible scraper (Argus included) can
    // pull it later without Heimdall depending on any of them being present.
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(renderMetrics(registry, store));
      return;
    }

    // Read-only live-status dashboard (hdl-ui-01) — first vertical slice of
    // the standalone-mode UI requirement (has_ui: true). Pure consumer of
    // GET /lanes below; adds no new backend query logic.
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderDashboardHtml(getActiveTheme(store), getAgentOnboardingDismissed(store)));
      return;
    }

    // hdl-unified-dashboard: dashboard visual theme, same read/write shape
    // as /routing-strategy.
    if (req.method === "GET" && req.url === "/theme") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ active: getActiveTheme(store), available: [...DASHBOARD_THEMES] }));
      return;
    }

    if (req.method === "POST" && req.url === "/theme") {
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const result = setTheme(store, (body.data as { theme?: unknown }).theme);
        if (!result.ok) {
          const { ok: _ok, ...wire } = result;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify(wire));
          return;
        }
        const { ok: _ok, ...wire } = result;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(wire));
      });
      return;
    }

    // hdl-ao-07: dismiss state for the dashboard's "get started" agent-
    // onboarding panel, same read/write shape as /theme and /desktop-icon.
    if (req.method === "GET" && req.url === "/agent-onboarding-dismissed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dismissed: getAgentOnboardingDismissed(store) }));
      return;
    }

    if (req.method === "POST" && req.url === "/agent-onboarding-dismissed") {
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const result = setAgentOnboardingDismissed(store, (body.data as { dismissed?: unknown }).dismissed);
        if (!result.ok) {
          const { ok: _ok, ...wire } = result;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify(wire));
          return;
        }
        const { ok: _ok, ...wire } = result;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(wire));
      });
      return;
    }

    // hdl-docs-viewer: "see and navigate the docs and work with the
    // diagrams" from inside the running service itself — the same content
    // that ships in docs/, rendered locally (markdown server-side, Mermaid
    // diagrams client-side against the vendored copy below — no CDN, no
    // network call, matching the dashboard's own "no external calls" bar).
    if (req.method === "GET" && req.url === "/docs") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderDocsIndexHtml());
      return;
    }

    const docMatch = req.method === "GET" && req.url?.match(/^\/docs\/([^/]+)$/);
    if (docMatch) {
      const doc = getDocBySlug(decodeURIComponent(docMatch[1]));
      if (!doc) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown_doc" }));
        return;
      }
      const bodyHtml = renderDocMarkdown(doc, docsRepoRoot);
      if (bodyHtml === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "doc_file_missing", path: doc.path }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderDocPageHtml(doc, bodyHtml));
      return;
    }

    // Vendored locally (see package.json's "marked"/"mermaid" dependencies)
    // and served from node_modules directly — no build step, no CDN.
    if (req.method === "GET" && req.url === "/vendor/mermaid.min.js") {
      try {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(readFileSync(mermaidBundlePath));
      } catch {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "mermaid_bundle_missing" }));
      }
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
        const result = addLane(registry, envFilePath, body.data as AddLaneInput);
        if (!result.ok) {
          const status = result.error === "lane_already_declared" ? 409 : 400;
          const { ok: _ok, ...wire } = result;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(wire));
          return;
        }
        const { ok: _ok, ...wire } = result;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(wire));
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

    // hdl-rs-03: which strategy /available-route delegates ranking/picking
    // to (priority | round-robin | off — see src/core/routing-strategies/).
    // A global setting, not per-lane — unset defaults to "priority",
    // byte-identical to every caller that never touches this route.
    if (req.method === "GET" && req.url === "/routing-strategy") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          active: getActiveRoutingStrategyName(store),
          available: getRoutingStrategyNames(),
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/routing-strategy") {
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const result = setRoutingStrategy(store, (body.data as { strategy?: unknown }).strategy);
        if (!result.ok) {
          const { ok: _ok, ...wire } = result;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify(wire));
          return;
        }
        const { ok: _ok, ...wire } = result;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(wire));
      });
      return;
    }

    // hdl-desktop-icon-settings: which bundled desktop-app icon concept is
    // preferred. The Node service only persists the preference — it has no
    // way to actually swap the running Tauri process's icon; the Rust
    // sidecar reads this on startup (tray icon: live; Dock icon: next
    // rebuild only, a real macOS/Tauri v2 limitation, not a gap in this
    // implementation).
    if (req.method === "GET" && req.url === "/desktop-icon") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ active: getActiveIcon(store), available: [...DESKTOP_ICONS] }));
      return;
    }

    if (req.method === "POST" && req.url === "/desktop-icon") {
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const result = setIcon(store, (body.data as { icon?: unknown }).icon);
        if (!result.ok) {
          const { ok: _ok, ...wire } = result;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify(wire));
          return;
        }
        const { ok: _ok, ...wire } = result;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(wire));
      });
      return;
    }

    // hdl-icon-reconciliation: real thumbnail preview for the Settings
    // picker -- it previously showed generic emoji standing in for each
    // option, not the actual designed artwork the operator reviewed and
    // picked between. :name is validated against the DESKTOP_ICONS
    // allowlist before touching the filesystem (same discipline as the
    // docs viewer's :slug handling -- never resolve an arbitrary
    // caller-supplied path).
    const iconThumbMatch = req.method === "GET" && req.url?.match(/^\/desktop-icon\/([^/]+)\/thumbnail\.png$/);
    if (iconThumbMatch) {
      const name = decodeURIComponent(iconThumbMatch[1]);
      if (!(DESKTOP_ICONS as readonly string[]).includes(name)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown_icon" }));
        return;
      }
      try {
        const png = readFileSync(join(iconSetsRoot, name, "128x128.png"));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        res.end(png);
      } catch {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "thumbnail_missing" }));
      }
      return;
    }

    // Read-only view of config/routing-policy.yaml (the scored strategy's
    // hand-edited policy file) so the dashboard doesn't require reading YAML
    // to see the active task-type weights/experiments. Loaded fresh on every
    // request (never cached) so a hand-edit is reflected immediately.
    if (req.method === "GET" && req.url === "/routing-policy") {
      try {
        const policy = PolicyLoader.load();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(policy));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "policy_unavailable", message }));
      }
      return;
    }

    // hdl-rr-03: always scored, regardless of the globally active strategy —
    // a caller hitting this endpoint is explicitly asking for the scored
    // contract (Auriga/Minerva's existing dispatch shape). GET
    // /available-route is the strategy-driven surface; this is not that.
    if (req.method === "POST" && req.url === "/route") {
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const data = body.data as { task_id?: unknown; task_type?: unknown; estimated_cost?: unknown };
        const taskId = typeof data.task_id === "string" ? data.task_id : null;
        const taskType = parseTaskType(typeof data.task_type === "string" ? data.task_type : null);
        if (!taskId || !taskType) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: "invalid_request",
              required: ["task_id", "task_type"],
              allowed_task_types: ["planning", "build", "review"],
            }),
          );
          return;
        }
        const estimatedCost = typeof data.estimated_cost === "number" ? data.estimated_cost : undefined;
        const result = getScoredRoute({ task_id: taskId, task_type: taskType, estimated_cost: estimatedCost }, registry, store);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      });
      return;
    }

    // hdl-rof-01: closes the loop RouteLedger was always designed for — a
    // caller that got a decision_id from POST /route reports back what
    // actually happened. 404 for an unrecognized decision id, never a crash.
    const routeOutcomeMatch = req.method === "POST" && req.url?.match(/^\/route\/([^/]+)\/outcome$/);
    if (routeOutcomeMatch) {
      const decisionId = decodeURIComponent(routeOutcomeMatch[1]);
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const data = body.data as { outcome?: unknown; actual_cost?: unknown; metadata?: unknown };
        const outcome = typeof data.outcome === "string" ? data.outcome : undefined;
        const actualCost = typeof data.actual_cost === "number" ? data.actual_cost : undefined;
        const metadata =
          typeof data.metadata === "object" && data.metadata !== null && !Array.isArray(data.metadata)
            ? (data.metadata as Record<string, JsonValue>)
            : undefined;
        const result = reportRouteOutcome({ decisionId, outcome, actualCost, metadata });
        if (!result.ok) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      });
      return;
    }

    // hdl-mc-05: "what models can I actually call right now" — the live,
    // locally-stored, per-installation catalog (see
    // .pHive/epics/hdl-model-catalog/docs/design-discussion.md).
    if (req.method === "GET" && req.url?.startsWith("/models")) {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/models") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const provider = url.searchParams.get("provider") ?? undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getModelCatalog(store, provider)));
      return;
    }

    if (req.method === "POST" && req.url === "/models/refresh") {
      refreshModelCatalog(store, registry, fetchImpl)
        .then((result) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch(() => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "refresh_failed" }));
        });
      return;
    }

    const modelEnabledMatch = req.method === "POST" && req.url?.match(/^\/models\/([^/]+)\/([^/]+)$/);
    if (modelEnabledMatch) {
      const provider = decodeURIComponent(modelEnabledMatch[1]);
      const modelId = decodeURIComponent(modelEnabledMatch[2]);
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const enabled = (body.data as { enabled?: unknown }).enabled;
        if (typeof enabled !== "boolean") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_enabled_value" }));
          return;
        }
        const result = setModelEnabled(store, provider, modelId, enabled);
        if (!result.ok) {
          const { ok: _ok, ...wire } = result;
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify(wire));
          return;
        }
        const { ok: _ok, ...wire } = result;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(wire));
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

    // hdl-lo-01: manual lane override — routes through the SAME
    // ControlAdapter.reconcile() decision as automatic status-driven
    // actuation (see MulticaControlAdapter's desiredEnabled computation),
    // not a separate mechanism. Takes effect on the next reconcile tick
    // (<=5s, same latency as the existing suspect-lane cadence).
    const overrideMatch = req.method === "POST" && req.url?.match(/^\/lanes\/([^/]+)\/override$/);
    if (overrideMatch) {
      const laneId = decodeURIComponent(overrideMatch[1]);
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const { state, reason } = body.data as { state?: unknown; reason?: unknown };
        const result = setLaneOverride(registry, store, laneId, state, reason);
        if (!result.ok) {
          const status = result.error === "unknown_lane" ? 404 : 400;
          const { ok: _ok, ...wire } = result;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(wire));
          return;
        }
        const { ok: _ok, ...wire } = result;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(wire));
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
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const resetAt = (body.data as { reset_at?: unknown }).reset_at;
        const result = setLaneResetAt(registry, store, laneId, resetAt);
        if (!result.ok) {
          const status = result.error === "unknown_lane" ? 404 : 400;
          const { ok: _ok, ...wire } = result;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(wire));
          return;
        }
        const { ok: _ok, ...wire } = result;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(wire));
      });
      return;
    }

    // hdl-rr-04: multi-account rotation status/action, one provider at a
    // time. Only present for providers with 2+ credentialed lanes — a
    // provider with 0 or 1 (or entirely unrecognized) reports
    // unknown_provider, never a crash.
    const rotationStatusMatch = req.method === "GET" && req.url?.match(/^\/rotation\/([^/]+)$/);
    if (rotationStatusMatch) {
      const provider = decodeURIComponent(rotationStatusMatch[1]);
      const result = getRotationStatus(rotationControllers, provider);
      const status = result.ok ? 200 : result.error === "unknown_provider" ? 404 : 409;
      const { ok: _ok, ...wire } = result;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(wire));
      return;
    }

    const rotationRotateMatch = req.method === "POST" && req.url?.match(/^\/rotation\/([^/]+)\/rotate$/);
    if (rotationRotateMatch) {
      const provider = decodeURIComponent(rotationRotateMatch[1]);
      const result = rotateProvider(rotationControllers, provider);
      const status = result.ok ? 200 : result.error === "unknown_provider" ? 404 : 409;
      const { ok: _ok, ...wire } = result;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(wire));
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
  const store = new StateStore(resolveDefaultDbPath());
  const port = Number(process.env.PORT ?? 4870);
  createHttpServer(registry, store).listen(port, () => {
    console.log(`heimdall dev server listening on http://localhost:${port}`);
  });
}
