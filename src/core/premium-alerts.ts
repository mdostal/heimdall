// heimdall#142 slice 6: one operator alert the moment a premium model becomes
// unavailable.
//
// An "episode" is one exhausted limit on one lane: (lane_id, limit kind).
// The first evaluation that sees that limit block an enabled model at an
// alert level (premium by default) raises the alert; every later evaluation
// sees the open row and stays quiet, so one limit raises one alert, however
// many signals repeat it. The open row is unique in SQLite (a partial unique
// index), so two processes sharing the database still raise it once. When
// the limit stops blocking (reset time passed, a new observation says
// available, or the operator cleared it) the alert resolves, and a later
// exhaustion of the same limit is a new episode with a new alert.
//
// Each alert carries the operator's choices:
// - swap: usable models at an alert level, same account first, then other
//   routable lanes (credential resolved, up or forced on, not excluded);
// - wait: until the limit's reported reset time, or "unknown";
// - human_reset: clear the limit by hand once the provider reset it;
// - credits: only when the lane reports a credits limit. Heimdall never
//   turns paid credits on; the operator decides.
//
// No estimates: a number the provider did not report reads "unknown".
//
// Delivery: telemetry (`operator_alert`), the in-process event bus
// (SSE `operator.alert` on GET /events, the dashboard banner), and an
// optional webhook (HEIMDALL_ALERT_WEBHOOK_URL). The webhook URL may carry a
// token, so it is never logged.

import { startBackgroundJob } from "./background-jobs.js";
import type { Lane, LaneRegistry } from "./lane-registry.js";
import { getLaneModels } from "./lane-models.js";
import type { LaneLimit } from "./limits.js";
import { getLevelPolicyState } from "./route-selector.js";
import { isLevel, resolveLevel, type Level, type LevelPolicy } from "./routing/levels.js";
import type { OperatorAlertRow, StateStore } from "./state-store.js";

export const PREMIUM_UNAVAILABLE = "premium_unavailable";
const DEFAULT_EVAL_INTERVAL_MS = 30_000;
const WEBHOOK_TIMEOUT_MS = 5_000;
const EMPTY_POLICY: LevelPolicy = { models: {}, lanes: {}, work_classes: {} };

export interface AlertConfig {
  /** Levels whose loss raises an alert (HEIMDALL_ALERT_LEVELS, default "premium"). */
  levels: Level[];
  /** Periodic re-evaluation, so time-based resets resolve (HEIMDALL_ALERT_EVAL_INTERVAL_MS). */
  evalIntervalMs: number;
  /** Optional POST target for new alerts (HEIMDALL_ALERT_WEBHOOK_URL). Never logged. */
  webhookUrl: string | null;
}

export function loadAlertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const levels = (env.HEIMDALL_ALERT_LEVELS ?? "premium")
    .split(",")
    .map((part) => part.trim())
    .filter(isLevel);
  const interval = Number(env.HEIMDALL_ALERT_EVAL_INTERVAL_MS);
  const webhook = env.HEIMDALL_ALERT_WEBHOOK_URL?.trim();
  return {
    levels: levels.length > 0 ? levels : ["premium"],
    evalIntervalMs: Number.isFinite(interval) && interval >= 1_000 ? interval : DEFAULT_EVAL_INTERVAL_MS,
    webhookUrl: webhook ? webhook : null,
  };
}

export interface SwapOption {
  lane_id: string;
  model_id: string;
  level: Level;
  same_account: boolean;
}

export type AlertChoice =
  | { action: "swap"; available: boolean; options: SwapOption[]; detail: string }
  | { action: "wait"; until: string; detail: string }
  | { action: "human_reset"; method: "POST"; path: string; body: { kind: string }; detail: string }
  | { action: "credits"; state: string; detail: string };

export interface PremiumAlert {
  id: number;
  type: typeof PREMIUM_UNAVAILABLE;
  lane_id: string;
  limit_kind: string;
  limit: {
    state: string;
    used_percent: number | "unknown";
    resets_at: string | "unknown";
    reason: string | null;
    source: string;
    observed_at: string;
  };
  /** The enabled alert-level models this limit made unavailable. */
  models: Array<{ model_id: string; level: Level }>;
  raised_at: string;
  message: string;
  choices: AlertChoice[];
  resolved_at: string | null;
  resolution: string | null;
}

export type AlertNotifier = (alert: PremiumAlert) => void | Promise<void>;

export interface EvaluateResult {
  raised: PremiumAlert[];
  resolved: Array<{ id: number; lane_id: string; limit_kind: string; resolution: string }>;
}

interface ModelAtLevel {
  model_id: string;
  level: Level;
  enabled: boolean;
  usable: boolean;
  blocked_by: string[];
}

function modelsAtLevels(lane: Lane, store: StateStore, policy: LevelPolicy, levels: Level[], now: Date): ModelAtLevel[] {
  const out: ModelAtLevel[] = [];
  for (const model of getLaneModels(lane, store, now)) {
    const { level } = resolveLevel(policy, lane, model.model_id);
    if (level === null || !levels.includes(level)) continue;
    out.push({ model_id: model.model_id, level, enabled: model.enabled, usable: model.usable, blocked_by: model.blocked_by });
  }
  return out;
}

function laneRoutable(lane: Lane, store: StateStore, excluded: ReadonlySet<string>): boolean {
  if (lane.credential === null || excluded.has(lane.lane_id)) return false;
  const override = store.getManualOverride(lane.lane_id);
  if (override === "disabled") return false;
  if (override === "enabled") return true;
  return store.getCurrentStatus(lane.lane_id)?.status === "up";
}

function swapOptions(
  registry: LaneRegistry,
  store: StateStore,
  lane: Lane,
  policy: LevelPolicy,
  levels: Level[],
  excluded: ReadonlySet<string>,
  now: Date,
): SwapOption[] {
  const options: SwapOption[] = [];
  for (const model of modelsAtLevels(lane, store, policy, levels, now)) {
    if (model.usable) options.push({ lane_id: lane.lane_id, model_id: model.model_id, level: model.level, same_account: true });
  }
  for (const other of registry.list()) {
    if (other.lane_id === lane.lane_id || !laneRoutable(other, store, excluded)) continue;
    for (const model of modelsAtLevels(other, store, policy, levels, now)) {
      if (model.usable) options.push({ lane_id: other.lane_id, model_id: model.model_id, level: model.level, same_account: false });
    }
  }
  return options;
}

function buildChoices(lane: Lane, limit: LaneLimit, swaps: SwapOption[], limits: LaneLimit[]): AlertChoice[] {
  const first = swaps[0];
  const choices: AlertChoice[] = [
    {
      action: "swap",
      available: swaps.length > 0,
      options: swaps,
      detail: first
        ? `swap to ${first.model_id} on ${first.lane_id} now`
        : "no usable model at this level on any routable lane",
    },
    {
      action: "wait",
      until: limit.resets_at ?? "unknown",
      detail: limit.resets_at ? `wait until ${limit.resets_at}` : "wait; the provider did not report a reset time (unknown)",
    },
    {
      action: "human_reset",
      method: "POST",
      path: `/lanes/${encodeURIComponent(lane.lane_id)}/limits/clear`,
      body: { kind: limit.kind },
      detail: "if the provider reset the limit early (e.g. a human reset), clear it here and routing picks the model back up",
    },
  ];
  const credits = limits.find((entry) => entry.kind === "credits");
  if (credits) {
    choices.push({
      action: "credits",
      state: credits.state,
      detail: "the account reports a credits limit; Heimdall never turns paid credits on, the operator decides",
    });
  }
  return choices;
}

function messageFor(laneId: string, limit: LaneLimit, models: Array<{ model_id: string }>, choices: AlertChoice[]): string {
  const names = models.map((model) => model.model_id).join(", ");
  const parts = choices.map((choice) => choice.detail);
  return `${names} unavailable on ${laneId}: ${limit.kind} exhausted. Choices: ${parts.join("; ")}.`;
}

function rowToAlert(row: OperatorAlertRow): PremiumAlert {
  const payload = JSON.parse(row.payload) as Omit<PremiumAlert, "id" | "resolved_at" | "resolution">;
  return { ...payload, id: row.id, resolved_at: row.resolved_at, resolution: row.resolution };
}

export function listOperatorAlerts(store: StateStore, options: { openOnly?: boolean; limit?: number } = {}): PremiumAlert[] {
  return store
    .listOperatorAlerts(options)
    .filter((row) => row.type === PREMIUM_UNAVAILABLE)
    .map(rowToAlert);
}

function resolutionFor(store: StateStore, laneId: string, kind: string, now: Date): string {
  const raw = store.getLimits(laneId, new Date(0)).find((limit) => limit.kind === kind);
  if (!raw) return "limit_cleared";
  if (raw.state === "exhausted" && raw.resets_at !== null && Date.parse(raw.resets_at) <= now.getTime()) return "limit_reset";
  return "limit_available";
}

/**
 * One pass: raise an alert for each new (lane, limit) that blocks an enabled
 * alert-level model, resolve the ones whose limit no longer blocks any.
 * `notify` runs once per newly raised alert.
 */
export function evaluatePremiumAlerts(
  registry: LaneRegistry,
  store: StateStore,
  now: Date = new Date(),
  notify?: AlertNotifier,
  config: AlertConfig = loadAlertConfig(),
): EvaluateResult {
  const { policy, excluded } = getLevelPolicyState();
  const levels = policy ?? EMPTY_POLICY;
  const result: EvaluateResult = { raised: [], resolved: [] };
  const blockingNow = new Set<string>();
  const key = (laneId: string, kind: string): string => `${laneId}\u0000${kind}`;

  for (const lane of registry.list()) {
    if (excluded.has(lane.lane_id)) continue;
    const models = modelsAtLevels(lane, store, levels, config.levels, now);
    if (models.length === 0) continue;
    const limits = store.getLimits(lane.lane_id, now);
    const byKind = new Map<string, Array<{ model_id: string; level: Level }>>();
    for (const model of models) {
      for (const kind of model.blocked_by) {
        blockingNow.add(key(lane.lane_id, kind));
        if (!model.enabled) continue;
        const list = byKind.get(kind) ?? [];
        list.push({ model_id: model.model_id, level: model.level });
        byKind.set(kind, list);
      }
    }
    for (const [kind, blocked] of byKind) {
      const limit = limits.find((entry) => entry.kind === kind);
      if (!limit) continue;
      const swaps = swapOptions(registry, store, lane, levels, config.levels, excluded, now);
      const choices = buildChoices(lane, limit, swaps, limits);
      const raisedAt = now.toISOString();
      const payload: Omit<PremiumAlert, "id" | "resolved_at" | "resolution"> = {
        type: PREMIUM_UNAVAILABLE,
        lane_id: lane.lane_id,
        limit_kind: kind,
        limit: {
          state: limit.state,
          used_percent: limit.used_percent ?? "unknown",
          resets_at: limit.resets_at ?? "unknown",
          reason: limit.reason,
          source: limit.source,
          observed_at: limit.observed_at,
        },
        models: blocked,
        raised_at: raisedAt,
        message: messageFor(lane.lane_id, limit, blocked, choices),
        choices,
      };
      const id = store.raiseOperatorAlert(PREMIUM_UNAVAILABLE, lane.lane_id, kind, JSON.stringify(payload), raisedAt);
      if (id === null) continue;
      const alert: PremiumAlert = { ...payload, id, resolved_at: null, resolution: null };
      result.raised.push(alert);
      store.recordTelemetryEvent(
        "operator_alert",
        { type: PREMIUM_UNAVAILABLE, laneId: lane.lane_id, limitKind: kind, models: blocked.map((m) => m.model_id).join(",") },
        raisedAt,
      );
      store.events.emitOperatorAlert(alert);
      if (notify) {
        try {
          const pending = notify(alert);
          if (pending && typeof (pending as Promise<void>).catch === "function") {
            (pending as Promise<void>).catch((err: unknown) => console.error("[premium-alerts] notifier failed:", errorText(err)));
          }
        } catch (err) {
          console.error("[premium-alerts] notifier failed:", errorText(err));
        }
      }
    }
  }

  for (const row of store.listOperatorAlerts({ openOnly: true, limit: 1000 })) {
    if (row.type !== PREMIUM_UNAVAILABLE || blockingNow.has(key(row.lane_id, row.limit_kind))) continue;
    // A lane no longer in the registry (or now excluded) also closes its alert.
    const resolution = resolutionFor(store, row.lane_id, row.limit_kind, now);
    if (store.resolveOperatorAlert(row.id, resolution, now.toISOString())) {
      result.resolved.push({ id: row.id, lane_id: row.lane_id, limit_kind: row.limit_kind, resolution });
    }
  }
  return result;
}

function errorText(err: unknown): string {
  // Never the URL: it may carry a token. Only the error's own name/message.
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return "unknown error";
}

/** POSTs the alert JSON to the configured webhook. Errors are logged without the URL. */
export function webhookNotifier(url: string, fetchImpl: typeof fetch = fetch): AlertNotifier {
  return async (alert) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`webhook answered HTTP ${response.status}`);
  };
}

export interface InstallPremiumAlertsOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Overrides the webhook notifier (tests). */
  notify?: AlertNotifier;
}

/**
 * Evaluates on every limit change and on a timer (resets are time-based).
 * Returns a stop function.
 */
export function installPremiumAlerts(registry: LaneRegistry, store: StateStore, options: InstallPremiumAlertsOptions = {}): () => void {
  const config = loadAlertConfig(options.env ?? process.env);
  const notify = options.notify ?? (config.webhookUrl ? webhookNotifier(config.webhookUrl, options.fetchImpl) : undefined);
  const run = (): void => {
    evaluatePremiumAlerts(registry, store, new Date(), notify, config);
  };
  const stopListening = store.events.onLimitsChanged(() => {
    try {
      run();
    } catch (err) {
      console.error("[premium-alerts] evaluation failed:", errorText(err));
    }
  });
  const job = startBackgroundJob({ name: "premium-alerts", run }, { intervalMs: config.evalIntervalMs, runImmediately: true });
  return () => {
    stopListening();
    job.stop();
  };
}
