// The one seam a new backoff policy plugs into (hdl-bp-02) — add a file
// implementing BackoffPolicy, register it here, touch nothing else. Mirrors
// src/core/routing-strategies/registry.ts's factory shape exactly.

import type { BackoffPolicy } from "./types.js";
import { StaticBackoff } from "./static-backoff.js";
import { ProgressiveBackoff } from "./progressive-backoff.js";
import { ExponentialProgressiveBackoff } from "./exponential-progressive-backoff.js";

export function createBackoffPolicyRegistry(): Record<string, BackoffPolicy> {
  return {
    static: new StaticBackoff(),
    progressive: new ProgressiveBackoff(),
    exponential: new ExponentialProgressiveBackoff(),
  };
}
