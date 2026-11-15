// heimdall#142 slice 1: subscription limits as first-class data.
//
// A Claude subscription has several separate limits: the 5-hour session
// window, the weekly all-models cap, and weekly per-model caps such as the
// Fable sub-limit. Before this, Heimdall folded every one of them into one
// lane-wide status, so "Fable is out, Opus is fine" could not be said. On
// 11/15 that cost 11 idle hours.
//
// Rules this module keeps:
// - A number is either observed or unknown. `used_percent` and `resets_at`
//   are null when the provider did not say, never an estimate.
// - Model display names in limit messages ("Fable") resolve to model ids
//   through configuration (HEIMDALL_CLAUDE_MODEL_ALIASES), not constants.
//   An unmapped name stays as its lowercase display name.

import type { ClaudeCapSignal } from "./error-parser.js";

/** `weekly_model:<model id>` carries the model the sub-limit applies to. */
export type LimitKind =
  | "five_hour"
  | "weekly_all_models"
  | `weekly_model:${string}`
  | "credits"
  | "spend_cap";

export type LimitScope = "account" | "model";

/**
 * `exhausted`: the provider said the limit is reached.
 * `available`: observed with room left, or its reset time has passed.
 * `unknown`: known to exist, state not observed.
 */
export type LimitState = "available" | "exhausted" | "unknown";

/** Where the observation came from. Mirrors SignalSource plus operator entry. */
export type LimitSource = "active_probe" | "passive" | "operator";

export const LIMIT_STATES: readonly LimitState[] = ["available", "exhausted", "unknown"];
export const LIMIT_SOURCES: readonly LimitSource[] = ["active_probe", "passive", "operator"];

/** One limit as observed, before it is tied to a lane. */
export interface LimitObservation {
  kind: LimitKind;
  scope: LimitScope;
  /** The model id for a `model`-scoped limit, else null. */
  model: string | null;
  state: LimitState;
  /** 0-100 when the provider reported it; null means unknown. */
  used_percent: number | null;
  /** Absolute ISO-8601 reset time when the provider gave one; null means unknown. */
  resets_at: string | null;
  /** The provider's own words, kept alongside the normalized kind. */
  reason: string | null;
}

/** A limit as stored and reported for a lane. */
export interface LaneLimit extends LimitObservation {
  lane_id: string;
  source: LimitSource;
  observed_at: string;
}

const MODEL_KIND_PREFIX = "weekly_model:";

export function isLimitKind(value: unknown): value is LimitKind {
  if (typeof value !== "string") return false;
  if (value === "five_hour" || value === "weekly_all_models" || value === "credits" || value === "spend_cap") {
    return true;
  }
  return value.startsWith(MODEL_KIND_PREFIX) && value.length > MODEL_KIND_PREFIX.length;
}

export function modelOfKind(kind: LimitKind): string | null {
  return kind.startsWith(MODEL_KIND_PREFIX) ? kind.slice(MODEL_KIND_PREFIX.length) : null;
}

export function scopeOfKind(kind: LimitKind): LimitScope {
  return modelOfKind(kind) === null ? "account" : "model";
}

/**
 * Parses HEIMDALL_CLAUDE_MODEL_ALIASES: comma-separated `name=model_id`
 * pairs, e.g. `fable=claude-fable-5-2,opus=claude-opus-5-5`. Names are
 * matched case-insensitively. Malformed pairs are skipped.
 */
export function parseModelAliases(raw: string | undefined | null): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!raw) return aliases;
  for (const pair of raw.split(",")) {
    const [name, model] = pair.split("=").map((part) => part?.trim() ?? "");
    if (name && model) aliases.set(name.toLowerCase(), model);
  }
  return aliases;
}

export function loadModelAliases(env: Record<string, string | undefined> = process.env): Map<string, string> {
  return parseModelAliases(env.HEIMDALL_CLAUDE_MODEL_ALIASES);
}

export function resolveModelName(displayName: string, aliases: Map<string, string>): string {
  const key = displayName.trim().toLowerCase();
  return aliases.get(key) ?? key;
}

/**
 * Maps a parsed Claude limit message to the limit it names. Returns null for
 * signals that are not a quota limit (a plain rate limit, an expired token).
 */
export function limitFromClaudeCapSignal(
  signal: ClaudeCapSignal,
  aliases: Map<string, string> = loadModelAliases(),
): LimitObservation | null {
  let kind: LimitKind;
  switch (signal.kind) {
    case "session_limit":
      kind = "five_hour";
      break;
    case "weekly_limit":
      kind = signal.model ? `weekly_model:${resolveModelName(signal.model, aliases)}` : "weekly_all_models";
      break;
    case "model_limit":
      if (!signal.model) return null;
      kind = `weekly_model:${resolveModelName(signal.model, aliases)}`;
      break;
    default:
      return null;
  }
  return {
    kind,
    scope: scopeOfKind(kind),
    model: modelOfKind(kind),
    state: "exhausted",
    used_percent: signal.used_percent ?? null,
    // A caller-built signal without the flag predates heimdall#142 and only ever carried provider reset times.
    resets_at: signal.reset_at_known === false ? null : signal.reset_at,
    reason: signal.reason,
  };
}

/**
 * The state to report now. An exhausted limit whose reset time has passed
 * reads as available: the provider's own reset time says so, and it is the
 * swap-back trigger later slices route on.
 */
export function effectiveLimit(limit: LaneLimit, now: Date): LaneLimit {
  if (limit.state !== "exhausted" || limit.resets_at === null) return limit;
  const resetMs = Date.parse(limit.resets_at);
  if (Number.isNaN(resetMs) || resetMs > now.getTime()) return limit;
  return {
    ...limit,
    state: "available",
    used_percent: null,
    reason: `reset time passed (${limit.resets_at}); last observed: ${limit.reason ?? "exhausted"}`,
  };
}

/** Human-readable one-liner for a limit, for status text and the CLI. */
export function describeLimit(limit: LaneLimit): string {
  const percent = limit.used_percent === null ? "usage unknown" : `${limit.used_percent}% used`;
  const reset = limit.resets_at === null ? "reset time unknown" : `resets ${limit.resets_at}`;
  return `${limit.kind}: ${limit.state} (${percent}, ${reset}, source ${limit.source})`;
}

/**
 * heimdall#142: true when a Claude cap names one model ("your Fable limit",
 * "your weekly Opus limit"). The account still serves other models, so the
 * lane itself stays usable and only that model's limit is exhausted.
 */
export function isModelScopedCap(signal: ClaudeCapSignal): boolean {
  return (signal.model ?? null) !== null && (signal.kind === "model_limit" || signal.kind === "weekly_limit");
}
