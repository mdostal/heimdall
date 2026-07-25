// Staleness/escalation logic — decides which signal layer to consult and
// when to escalate to an active probe (REQ-01/02/03 orchestration).
// Pure decision logic against signal timestamps — no adapters, no I/O, no
// provider-specific knowledge. `now` is always injected (never Date.now()
// internally) so this is fully deterministic and testable.

export type EscalationAction = "use-passive" | "use-public-status" | "escalate-to-probe";

export interface EscalationDecision {
  action: EscalationAction;
}

export interface EscalationInput {
  /** ISO-8601 timestamp for "now" — injected, never computed internally. */
  now: string;
  /** Timestamp of the last passive observation, or null if there's been none. */
  passiveSignalAt: string | null;
  /** Timestamp of the last public-status check, or null if there's been none. */
  publicStatusSignalAt: string | null;
  passiveStalenessMs: number;
  publicStatusStalenessMs: number;
}

// GAP-01 placeholder defaults (PRD: "exact per-provider staleness threshold
// ... is undefined"). Conservative starting points; tune once lhs-06's SLA
// harness can measure real behavior against the 10s SLA target.
export const DEFAULT_PASSIVE_STALENESS_MS = 30_000; // 30s
export const DEFAULT_PUBLIC_STATUS_STALENESS_MS = 60_000; // 60s

export function decideSignalSource(input: EscalationInput): EscalationDecision {
  const nowMs = Date.parse(input.now);

  const passiveFresh =
    input.passiveSignalAt !== null &&
    nowMs - Date.parse(input.passiveSignalAt) <= input.passiveStalenessMs;
  if (passiveFresh) {
    return { action: "use-passive" };
  }

  const publicStatusFresh =
    input.publicStatusSignalAt !== null &&
    nowMs - Date.parse(input.publicStatusSignalAt) <= input.publicStatusStalenessMs;
  if (publicStatusFresh) {
    return { action: "use-public-status" };
  }

  // No passive signal (or it's stale) AND no fresh public-status signal —
  // REQ-01 requires we don't assume `down` from absence, and REQ-03 says
  // this is exactly when a sparse active check is warranted.
  return { action: "escalate-to-probe" };
}

// --- Corroboration policy ---------------------------------------------------
//
// signal-inventory.md's key finding: both Claude and Codex have a documented
// false-positive risk on their primary failure signal (429 / usage-limit
// reached despite available quota). Don't resolve a lane to down/out_of_credit
// from a single probe alone — require the same severe verdict twice in a row
// before trusting it. This directly serves the north-star's stated pain point
// ("... produce false failures, corrupt metrics, drop work, and halt
// operations").

export type Verdict = "up" | "down" | "out_of_credit" | "degraded";

export function requiresCorroboration(verdict: Verdict): boolean {
  return verdict === "down" || verdict === "out_of_credit";
}

export interface CorroborationInput {
  latestVerdict: Verdict;
  /** The verdict from the immediately preceding check, or null if there is none yet. */
  priorVerdict: Verdict | null;
}

export interface CorroborationResult {
  verdict: Verdict;
  corroborated: boolean;
}

export function resolveWithCorroboration(input: CorroborationInput): CorroborationResult {
  if (!requiresCorroboration(input.latestVerdict)) {
    return { verdict: input.latestVerdict, corroborated: true };
  }
  if (input.priorVerdict === input.latestVerdict) {
    return { verdict: input.latestVerdict, corroborated: true };
  }
  // Not corroborated — report `degraded` rather than the more severe
  // down/out_of_credit verdict, since a single-signal false positive is a
  // documented risk for both providers in this spike.
  return { verdict: "degraded", corroborated: false };
}
