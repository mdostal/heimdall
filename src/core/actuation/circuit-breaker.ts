// CircuitBreaker — generic consecutive-failure circuit breaker (hda-01).
// Not Multica-specific — wraps any async call. Opens after N consecutive
// failures (further calls short-circuit immediately, no attempt made),
// half-opens after a cooldown window to test recovery with exactly one
// trial call, and closes again on success.

export type CircuitState = "closed" | "open" | "half-open";

export type CircuitBreakerResult<T> = { circuitOpen: false; result: T } | { circuitOpen: true };

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  /** Injectable clock (epoch ms) — for deterministic tests, never Date.now() internally by default in tests. */
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private consecutiveFailures = 0;
  private state: CircuitState = "closed";
  private openedAt: number | null = null;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** The effective state right now — transitions open -> half-open automatically once the cooldown elapses. */
  getState(): CircuitState {
    if (this.state === "open" && this.openedAt !== null && this.now() - this.openedAt >= this.cooldownMs) {
      return "half-open";
    }
    return this.state;
  }

  async call<T>(fn: () => Promise<T>, isSuccess: (result: T) => boolean): Promise<CircuitBreakerResult<T>> {
    if (this.getState() === "open") {
      return { circuitOpen: true };
    }

    const result = await fn();
    if (isSuccess(result)) {
      this.onSuccess();
    } else {
      this.onFailure();
    }
    return { circuitOpen: false, result };
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.openedAt = null;
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}
