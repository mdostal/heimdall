// The one seam a new backoff policy plugs into (hdl-bp-02) — add a file
// implementing BackoffPolicy, register it here, touch nothing else. Mirrors
// src/core/routing-strategies/registry.ts's factory shape exactly.

import type { BackoffPolicy } from "./types.js";
import { StaticBackoff } from "./static-backoff.js";
import { ProgressiveBackoff } from "./progressive-backoff.js";
import { ExponentialProgressiveBackoff } from "./exponential-progressive-backoff.js";
import type { StateStore } from "../../state-store.js";

export function createBackoffPolicyRegistry(): Record<string, BackoffPolicy> {
  return {
    static: new StaticBackoff(),
    progressive: new ProgressiveBackoff(),
    exponential: new ExponentialProgressiveBackoff(),
  };
}

// hdl-bp-04: settings-table persistence, mirroring routing_strategy's real,
// split-ownership pattern EXACTLY (src/core/route-selector.ts:
// ROUTING_STRATEGY_SETTING_KEY/getActiveRoutingStrategyName live in the core
// file that actually consumes the setting; only the write side
// (setRoutingStrategy) + HTTP handlers live in http-server.ts). This file is
// the core file InProcessScheduler imports from, so the setting key and its
// read-side resolution live here — the write side (setBackoffPolicy) lives
// in http-server.ts alongside the other shared mutation functions.
export const BACKOFF_POLICY_SETTING_KEY = "backoff_policy";
export const DEFAULT_BACKOFF_POLICY_NAME = "static";

export function getBackoffPolicyNames(): string[] {
  return Object.keys(createBackoffPolicyRegistry());
}

export function getActiveBackoffPolicyName(store: StateStore): string {
  const stored = store.getSetting(BACKOFF_POLICY_SETTING_KEY);
  const policies = createBackoffPolicyRegistry();
  return stored && policies[stored] ? stored : DEFAULT_BACKOFF_POLICY_NAME;
}

// hdl-bp-04: per-provider override — one flat settings key per known
// provider (design-discussion.md §3 item 6: grill C1 caught an earlier draft
// proposing a JSON-map row for this in the same breath as arguing every
// settings row should stay scalar; six flat keys instead, consistent with
// every other row in the table). Real provider identifiers, not guessed —
// sourced from src/main.ts's PROVIDER_ADAPTERS / src/core/lane-pipeline.ts's
// exported adapter factories (claudeAdapters/codexAdapters/geminiAdapters/
// kimiAdapters/openrouterAdapters/ollamaAdapters), the actual set of
// providers a lane's `provider` field can be.
export const KNOWN_BACKOFF_OVERRIDE_PROVIDERS = ["claude", "codex", "gemini", "kimi", "openrouter", "ollama"] as const;

export function backoffPolicyOverrideSettingKey(provider: string): string {
  return `backoff_policy_override_${provider}`;
}

/**
 * Resolves the effective policy NAME for a specific provider's lane(s):
 * a present + valid provider-specific override wins outright (whole-policy
 * replacement, not a per-parameter override — design-discussion.md §6 open
 * question 1: a provider needing a genuinely different heuristic, e.g.
 * Ollama never rate-limiting and reasonably wanting `static` even when the
 * global default is `exponential`, is the more likely real use case);
 * absent or invalid (unknown policy name) falls through to the global
 * choice from getActiveBackoffPolicyName.
 */
export function getBackoffPolicyNameForProvider(store: StateStore, provider: string): string {
  const policies = createBackoffPolicyRegistry();
  const override = store.getSetting(backoffPolicyOverrideSettingKey(provider));
  if (override && policies[override]) return override;
  return getActiveBackoffPolicyName(store);
}

// hdl-bp-04: per-policy parameters, each its own flat settings key with the
// design-discussion's worked-example defaults (§3 item 2) — every row a
// simple scalar, no JSON blobs.
export const BACKOFF_PROGRESSIVE_LEVEL_CAP_SETTING_KEY = "backoff_progressive_level_cap";
export const BACKOFF_EXPONENTIAL_MULTIPLIER_SETTING_KEY = "backoff_exponential_multiplier";
export const BACKOFF_EXPONENTIAL_CEILING_MS_SETTING_KEY = "backoff_exponential_ceiling_ms";

const DEFAULT_PROGRESSIVE_LEVEL_CAP = 10;
const DEFAULT_EXPONENTIAL_MULTIPLIER = 2;
const DEFAULT_EXPONENTIAL_CEILING_MS = 300_000;

function readNumberSetting(store: StateStore, key: string, fallback: number): number {
  const raw = store.getSetting(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Builds the `config` object a BackoffPolicy.nextDelayMs() expects for
 * whichever policy is active — `{levelCap}` for progressive,
 * `{multiplier, ceilingMs}` for exponential, `{}` for static (and any
 * unrecognized name, matching static's own ignore-config behavior).
 */
export function getBackoffPolicyConfig(store: StateStore, policyName: string): Record<string, unknown> {
  switch (policyName) {
    case "progressive":
      return {
        levelCap: readNumberSetting(store, BACKOFF_PROGRESSIVE_LEVEL_CAP_SETTING_KEY, DEFAULT_PROGRESSIVE_LEVEL_CAP),
      };
    case "exponential":
      return {
        multiplier: readNumberSetting(store, BACKOFF_EXPONENTIAL_MULTIPLIER_SETTING_KEY, DEFAULT_EXPONENTIAL_MULTIPLIER),
        ceilingMs: readNumberSetting(store, BACKOFF_EXPONENTIAL_CEILING_MS_SETTING_KEY, DEFAULT_EXPONENTIAL_CEILING_MS),
      };
    default:
      return {};
  }
}
