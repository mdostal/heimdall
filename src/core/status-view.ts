// heimdall#142 slice 6: the limits / models / mode / swaps status view.
//
// One read shared by GET /status, MCP heimdall.status, the CLI
// (`heimdall status`) and the dashboard:
// - per account (lane): each limit with its type, state, percent and reset;
// - per account: its models with enabled, available and level;
// - the mode: max usage on/off with its expiry;
// - the last swaps, and the operator alerts (open first).
//
// No estimates: every number is either observed or the string "unknown".

import type { LaneRegistry } from "./lane-registry.js";
import { getLaneModels } from "./lane-models.js";
import { getMaxUsageStatus } from "./max-usage.js";
import { listOperatorAlerts, type PremiumAlert } from "./premium-alerts.js";
import { getActiveRoutingStrategyName, getLevelPolicyState, getModelSwapsReport, type ModelSwapsReport } from "./route-selector.js";
import { resolveLevel, type Level, type LevelPolicy } from "./routing/levels.js";
import type { StateStore } from "./state-store.js";

const EMPTY_POLICY: LevelPolicy = { models: {}, lanes: {}, work_classes: {} };
export const DEFAULT_STATUS_SWAPS = 10;
const UNKNOWN = "unknown" as const;

export interface StatusLimit {
  kind: string;
  scope: string;
  model: string | null;
  state: string;
  used_percent: number | typeof UNKNOWN;
  resets_at: string | typeof UNKNOWN;
  reason: string | null;
  source: string;
  observed_at: string;
}

export interface StatusModel {
  model_id: string;
  enabled: boolean;
  available: boolean;
  usable: boolean;
  level: Level | "unbound";
  level_source: string | null;
  blocked_by: string[];
  available_at: string | typeof UNKNOWN | null;
  manual: "enabled" | "disabled" | null;
}

export interface StatusAccount {
  lane_id: string;
  provider: string;
  model: string;
  status: string;
  manual_override: string | null;
  limits: StatusLimit[];
  models: StatusModel[];
  mode: {
    max_usage: boolean;
    until: string | null;
    effective: boolean;
    ineffective_reason: string | null;
  };
  current_swap: ModelSwapsReport["current"][number] | null;
}

export interface StatusView {
  generated_at: string;
  routing_strategy: string;
  levels: "configured" | "not_configured" | "invalid";
  levels_error: string | null;
  accounts: StatusAccount[];
  last_swaps: ModelSwapsReport["events"];
  alerts: { open: PremiumAlert[]; recent: PremiumAlert[] };
}

export interface StatusViewOptions {
  swaps?: number;
  now?: Date;
}

export function getStatusView(registry: LaneRegistry, store: StateStore, options: StatusViewOptions = {}): StatusView {
  const now = options.now ?? new Date();
  const levels = getLevelPolicyState();
  const policy = levels.policy ?? EMPTY_POLICY;
  const swaps = getModelSwapsReport(store, options.swaps ?? DEFAULT_STATUS_SWAPS);
  const currentSwap = new Map(swaps.current.map((swap) => [swap.lane_id, swap]));

  const accounts = registry.list().map((lane): StatusAccount => {
    const mode = getMaxUsageStatus(store, lane.lane_id, now);
    return {
      lane_id: lane.lane_id,
      provider: lane.provider,
      model: lane.model,
      status: store.getCurrentStatus(lane.lane_id)?.status ?? UNKNOWN,
      manual_override: store.getManualOverride(lane.lane_id),
      limits: store.getLimits(lane.lane_id, now).map((limit) => ({
        kind: limit.kind,
        scope: limit.scope,
        model: limit.model,
        state: limit.state,
        used_percent: limit.used_percent ?? UNKNOWN,
        resets_at: limit.resets_at ?? UNKNOWN,
        reason: limit.reason,
        source: limit.source,
        observed_at: limit.observed_at,
      })),
      models: getLaneModels(lane, store, now).map((model) => {
        const { level, source } = resolveLevel(policy, lane, model.model_id);
        return {
          model_id: model.model_id,
          enabled: model.enabled,
          available: model.available,
          usable: model.usable,
          level: level ?? "unbound",
          level_source: source,
          blocked_by: model.blocked_by,
          // null: nothing blocks it; "unknown": blocked with no reported reset.
          available_at: model.available ? null : model.available_at ?? UNKNOWN,
          manual: model.manual,
        };
      }),
      mode: {
        max_usage: mode.enabled,
        until: mode.until,
        effective: mode.effective,
        ineffective_reason: mode.ineffective_reason,
      },
      current_swap: currentSwap.get(lane.lane_id) ?? null,
    };
  });

  return {
    generated_at: now.toISOString(),
    routing_strategy: getActiveRoutingStrategyName(store),
    levels: levels.state,
    levels_error: levels.error,
    accounts,
    last_swaps: swaps.events,
    alerts: {
      open: listOperatorAlerts(store, { openOnly: true }),
      recent: listOperatorAlerts(store, { limit: 10 }),
    },
  };
}

/** Plain-text rendering for the CLI and the heimdall-status skill. */
export function renderStatusText(view: StatusView): string {
  const lines: string[] = [];
  lines.push(`Heimdall status at ${view.generated_at} (routing: ${view.routing_strategy}, levels: ${view.levels})`);
  if (view.alerts.open.length > 0) {
    lines.push("", "OPEN ALERTS");
    for (const alert of view.alerts.open) lines.push(`  ! ${alert.message}`);
  }
  for (const account of view.accounts) {
    lines.push("", `${account.lane_id} (${account.provider}) status ${account.status}${account.manual_override ? `, forced ${account.manual_override}` : ""}`);
    lines.push(`  mode: max usage ${account.mode.max_usage ? `on until ${account.mode.until}${account.mode.effective ? "" : ` (not effective: ${account.mode.ineffective_reason})`}` : "off"}`);
    if (account.current_swap) lines.push(`  swapped: ${account.current_swap.preferred_model} -> ${account.current_swap.model} since ${account.current_swap.swapped_at}`);
    lines.push("  limits:");
    if (account.limits.length === 0) lines.push("    none reported");
    for (const limit of account.limits) {
      const percent = limit.used_percent === UNKNOWN ? "unknown %" : `${limit.used_percent}%`;
      lines.push(`    ${limit.kind}: ${limit.state}, ${percent}, resets ${limit.resets_at}`);
    }
    lines.push("  models:");
    for (const model of account.models) {
      const state = model.usable ? "usable" : !model.enabled ? "disabled" : `unavailable until ${model.available_at}`;
      lines.push(`    ${model.model_id} [${model.level}]: enabled ${model.enabled}, available ${model.available} (${state})`);
    }
  }
  lines.push("", "LAST SWAPS");
  if (view.last_swaps.length === 0) lines.push("  none");
  for (const swap of view.last_swaps) lines.push(`  ${swap.recordedAt} ${swap.laneId}: ${swap.event} ${swap.fromModel} -> ${swap.toModel}`);
  return lines.join("\n");
}
