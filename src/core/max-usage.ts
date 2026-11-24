// heimdall#142 slice 5: "max usage" mode, per account, on request.
//
// The founder's ask: "try to get the MAX usage out of the account when
// requested". A lane is one account (slice 4). When the operator turns max
// usage on for a lane, until an expiry they choose:
//
// - The lane works through every premium model it serves, in its configured
//   preference order, as each one's limit is reached: the slice-4 swap runs
//   for this lane even when the policy's `model_swap.enabled` is false.
// - With `max_usage.prefer_account` (default true), work goes to the
//   max-usage lanes ahead of other lanes while any of them has a usable
//   model at an allowed level, so the account's room is used before it
//   resets. Once every allowed model on those lanes is exhausted, routing
//   falls back to the other lanes exactly as it would with max usage off,
//   and with nothing left at an allowed level the verdict is `queue`.
// - The slice-3 floor still holds: code work never routes below premium,
//   and a swap never goes below the preferred model's level.
//
// What it never does: turn on paid credits, raise a spend cap, or change
// any limit. Those stay human switches. Heimdall reports whether the
// account has a `credits` / `spend_cap` limit and what state it is in, and
// rejects any request that tries to set them through this switch.
//
// Off by default; it is always time-boxed (`until` is required and capped
// by `max_usage.max_hours`), and it is persisted, so it survives a restart
// and expires on time. Shared by HTTP, MCP and the dashboard so all three
// validate the same way.

import type { LaneRegistry } from "./lane-registry.js";
import type { LaneLimit } from "./limits.js";
import type { StateStore } from "./state-store.js";
import { getMaxUsagePolicy } from "./route-selector.js";
import { PolicyValidationError } from "./routing/policy-loader.js";

/** Limit kinds that are paid-usage switches: reported, never changed. */
export const PAID_SWITCH_KINDS = ["credits", "spend_cap"] as const;
export type PaidSwitchKind = (typeof PAID_SWITCH_KINDS)[number];

export const PAID_SWITCHES_NOTE =
  "Reported only. Max usage never turns on paid credits or raises a spend cap; those stay human switches.";

export interface PaidSwitch {
  kind: PaidSwitchKind;
  /** False when the account never reported this limit. */
  reported: boolean;
  /** The limit's state as observed (available / exhausted / unknown); null when not reported. */
  state: LaneLimit["state"] | null;
  used_percent: number | null;
  resets_at: string | null;
  source: LaneLimit["source"] | null;
  observed_at: string | null;
  reason: string | null;
}

export interface MaxUsageStatus {
  lane_id: string;
  /** True while the operator's switch is on and unexpired. */
  enabled: boolean;
  reason: string | null;
  /** When it turns itself off; null when off. */
  until: string | null;
  set_at: string | null;
  /**
   * True when routing acts on it: the switch is on and the policy configures
   * levels. Without levels Heimdall can't tell premium from lower models,
   * so neither swap nor max usage acts.
   */
  effective: boolean;
  ineffective_reason: "off" | "levels_not_configured" | "invalid_policy" | null;
  /** The account's `credits` and `spend_cap` limits, as observed. */
  paid_switches: PaidSwitch[];
  paid_switches_note: string;
}

function paidSwitches(limits: LaneLimit[]): PaidSwitch[] {
  return PAID_SWITCH_KINDS.map((kind) => {
    const limit = limits.find((entry) => entry.kind === kind);
    return limit
      ? {
          kind,
          reported: true,
          state: limit.state,
          used_percent: limit.used_percent,
          resets_at: limit.resets_at,
          source: limit.source,
          observed_at: limit.observed_at,
          reason: limit.reason,
        }
      : { kind, reported: false, state: null, used_percent: null, resets_at: null, source: null, observed_at: null, reason: null };
  });
}

function levelsState(): { levelsConfigured: boolean; invalid: boolean } {
  try {
    return { levelsConfigured: getMaxUsagePolicy().levelsConfigured, invalid: false };
  } catch (error) {
    if (error instanceof PolicyValidationError) return { levelsConfigured: false, invalid: true };
    throw error;
  }
}

/** One lane's max-usage status at `now`. */
export function getMaxUsageStatus(store: StateStore, laneId: string, now: Date = new Date()): MaxUsageStatus {
  const row = store.getLaneMaxUsage(laneId, now)[0] ?? null;
  const { levelsConfigured, invalid } = levelsState();
  const ineffective = row === null ? "off" : invalid ? "invalid_policy" : levelsConfigured ? null : "levels_not_configured";
  return {
    lane_id: laneId,
    enabled: row !== null,
    reason: row?.reason ?? null,
    until: row?.until ?? null,
    set_at: row?.set_at ?? null,
    effective: ineffective === null,
    ineffective_reason: ineffective,
    paid_switches: paidSwitches(store.getLimits(laneId, now)),
    paid_switches_note: PAID_SWITCHES_NOTE,
  };
}

export type GetMaxUsageResult =
  | { ok: true; lanes: MaxUsageStatus[] }
  | { ok: false; error: "unknown_lane"; lane_id: string };

/** Every declared lane's max-usage status, or one lane's when `laneId` is given. */
export function getMaxUsageReport(registry: LaneRegistry, store: StateStore, laneId?: string, now: Date = new Date()): GetMaxUsageResult {
  if (laneId !== undefined) {
    if (!registry.get(laneId)) return { ok: false, error: "unknown_lane", lane_id: laneId };
    return { ok: true, lanes: [getMaxUsageStatus(store, laneId, now)] };
  }
  return { ok: true, lanes: registry.list().map((lane) => getMaxUsageStatus(store, lane.lane_id, now)) };
}

export type SetMaxUsageResult =
  | { ok: true; lane_id: string; max_usage: MaxUsageStatus }
  | { ok: false; error: "unknown_lane"; lane_id: string }
  | { ok: false; error: "not_a_heimdall_switch"; field: string; message: string }
  | { ok: false; error: "unknown_field"; field: string; message: string }
  | { ok: false; error: "invalid_enabled"; message: string }
  | { ok: false; error: "invalid_reason"; message: string }
  | { ok: false; error: "invalid_until"; message: string }
  | { ok: false; error: "invalid_policy"; message: string };

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
const ACCEPTED_FIELDS = new Set(["enabled", "reason", "until"]);
/** Fields that would change spend. Named explicitly so the refusal says why. */
const PAID_FIELDS = /credit|spend|cap|budget|overage/i;

/**
 * Turn max usage on (`enabled: true`, with a required future `until` no more
 * than `max_usage.max_hours` ahead, and an optional `reason`) or off
 * (`enabled: false`). Any other field is refused; a field naming credits or
 * a spend cap is refused as `not_a_heimdall_switch`.
 */
export function setMaxUsage(
  registry: LaneRegistry,
  store: StateStore,
  laneId: string,
  input: Record<string, unknown>,
  now: Date = new Date(),
): SetMaxUsageResult {
  for (const field of Object.keys(input)) {
    if (ACCEPTED_FIELDS.has(field)) continue;
    if (PAID_FIELDS.test(field)) {
      return { ok: false, error: "not_a_heimdall_switch", field, message: `${field}: ${PAID_SWITCHES_NOTE}` };
    }
    return { ok: false, error: "unknown_field", field, message: `${field} is not a max-usage field (expected enabled, until, reason)` };
  }
  if (!registry.get(laneId)) return { ok: false, error: "unknown_lane", lane_id: laneId };
  const { enabled, reason, until } = input;
  if (enabled !== true && enabled !== false) {
    return { ok: false, error: "invalid_enabled", message: "enabled must be true (on, with until) or false (off)" };
  }
  if (enabled === false) {
    if (store.clearLaneMaxUsage(laneId)) store.recordTelemetryEvent("max_usage_off", { laneId }, now.toISOString());
    return { ok: true, lane_id: laneId, max_usage: getMaxUsageStatus(store, laneId, now) };
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return { ok: false, error: "invalid_reason", message: "reason must be a string or null" };
  }
  let maxHours: number;
  try {
    maxHours = getMaxUsagePolicy().policy.max_hours;
  } catch (error) {
    if (error instanceof PolicyValidationError) return { ok: false, error: "invalid_policy", message: error.message };
    throw error;
  }
  if (typeof until !== "string" || !ISO_WITH_ZONE.test(until) || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= now.getTime()) {
    return { ok: false, error: "invalid_until", message: "until is required: a future ISO-8601 timestamp with timezone" };
  }
  if (Date.parse(until) - now.getTime() > maxHours * 3_600_000) {
    return { ok: false, error: "invalid_until", message: `until may be at most ${maxHours} hours ahead (max_usage.max_hours)` };
  }
  const note = typeof reason === "string" && reason.trim() !== "" ? reason : null;
  store.setLaneMaxUsage(laneId, note, until, now);
  store.recordTelemetryEvent("max_usage_on", { laneId, until: new Date(until).toISOString() }, now.toISOString());
  return { ok: true, lane_id: laneId, max_usage: getMaxUsageStatus(store, laneId, now) };
}
