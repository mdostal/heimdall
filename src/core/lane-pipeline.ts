// Claude end-to-end integration (lhs-03f) — wires the independently-built
// pieces (lhs-03a passive core, lhs-03b Claude public-status adapter, lhs-03c
// Claude active-probe adapter, lhs-03d escalation logic, lhs-03e resolution
// model) into one real pipeline for a Claude lane, persisting through
// lhs-02's state-store.
//
// Named lane-pipeline.ts rather than folding this into lane-registry.ts (the
// story's original file guess) — lane-registry.ts stays focused on
// declaration + credential resolution; this file owns the per-refresh signal
// pipeline. Behavior/acceptance criteria are what lhs-03f's story YAML
// specifies; file layout is an implementation-time call.
//
// refreshClaudeLaneStatus() is meant to be invoked periodically by a
// scheduler (or on-demand) — NOT on every GET /lanes request, per the
// discovery brief's token-conscious design principle. GET /lanes
// (http-server.ts) just reads whatever this pipeline last persisted to the
// state-store.

import { observePassiveSignal, type ResponseLike } from "./signal-sources/passive.js";
import { checkClaudePublicStatus } from "./signal-sources/public-status/claude.js";
import { probeClaudeLane } from "./signal-sources/active-probe/claude.js";
import {
  decideSignalSource,
  resolveWithCorroboration,
  DEFAULT_PASSIVE_STALENESS_MS,
  DEFAULT_PUBLIC_STATUS_STALENESS_MS,
} from "./signal-sources/escalation.js";
import { resolveStatus, type LaneStatusValue, type SignalSource } from "./status-model.js";
import type { StateStore } from "./state-store.js";
import type { Lane } from "./lane-registry.js";

export interface RefreshDeps {
  /** Injected clock — an ISO-8601 timestamp for "now". Never Date.now() internally. */
  now: () => string;
  /** Surfaces the last real agent response/error observed on this lane, or
   * null if nothing recent — the REQ-01 passive-observation input. No live
   * agent traffic routes through Heimdall yet, so real callers wire this up
   * once that integration exists; until then, returning null is honest and
   * correctly falls through to public-status/active-probe. */
  lastPassiveResponse: (laneId: string) => ResponseLike | null;
  fetchImpl?: typeof fetch;
}

/**
 * Owns per-lane corroboration state (the last RAW, pre-corroboration verdict
 * seen for each lane) across repeated refresh calls. Deliberately
 * instance-scoped rather than a module-level global — each service process
 * (or each test) gets its own tracker, so state doesn't leak across tests or
 * across independently-configured pipelines. Not persisted to SQLite:
 * resetting on restart is an acceptable, conservative tradeoff — the first
 * down/out_of_credit signal after a restart always requires one more
 * corroborating read before being trusted.
 *
 * Corroboration compares against the actual PRIOR RAW signal, not the
 * (possibly downgraded) status that was displayed — otherwise a lane
 * genuinely stuck receiving real "down" signals would never resolve past
 * "degraded", since each comparison would be against its own downgraded output.
 */
export class ClaudeLanePipeline {
  private readonly lastRawVerdictByLane = new Map<string, LaneStatusValue>();

  constructor(
    private readonly store: StateStore,
    private readonly deps: RefreshDeps,
  ) {}

  async refresh(lane: Lane): Promise<void> {
    const now = this.deps.now();
    const decision = decideSignalSource({
      now,
      passiveSignalAt: this.store.getLastObservedAt(lane.lane_id, "passive"),
      publicStatusSignalAt: this.store.getLastObservedAt(lane.lane_id, "public_status"),
      passiveStalenessMs: DEFAULT_PASSIVE_STALENESS_MS,
      publicStatusStalenessMs: DEFAULT_PUBLIC_STATUS_STALENESS_MS,
    });

    if (decision.action === "use-passive") {
      const signal = observePassiveSignal(this.deps.lastPassiveResponse(lane.lane_id));
      if (!signal) {
        // Thought passive was fresh but there's nothing to observe —
        // defensive fallback rather than trusting a null read.
        await this.refreshViaProbe(lane, now);
        return;
      }
      this.persistResolved(lane.lane_id, resolveStatus(signal), "passive", now);
      return;
    }

    if (decision.action === "use-public-status") {
      const signal = await checkClaudePublicStatus(this.deps.fetchImpl);
      this.persistResolved(lane.lane_id, resolveStatus(signal), "public_status", now);
      return;
    }

    await this.refreshViaProbe(lane, now);
  }

  private async refreshViaProbe(lane: Lane, now: string): Promise<void> {
    if (!lane.credential) {
      // REQ-07: missing/invalid credential — report down/unconfigured, never crash.
      this.store.recordStatus({
        lane_id: lane.lane_id,
        status: "down",
        reset_at: null,
        reason: "unconfigured — no credential available for active probe",
        signal_source: "active_probe",
        observed_at: now,
      });
      return;
    }

    const probe = await probeClaudeLane(lane.credential, this.deps.fetchImpl);
    this.persistResolved(lane.lane_id, resolveStatus(probe), "active_probe", now);
  }

  private persistResolved(
    laneId: string,
    resolved: { status: LaneStatusValue; reset_at: string | null; reason: string | null },
    source: SignalSource,
    now: string,
  ): void {
    const priorRawVerdict = this.lastRawVerdictByLane.get(laneId) ?? null;
    const corroboration = resolveWithCorroboration({
      latestVerdict: resolved.status,
      priorVerdict: priorRawVerdict,
    });
    this.lastRawVerdictByLane.set(laneId, resolved.status);

    this.store.recordStatus({
      lane_id: laneId,
      status: corroboration.verdict,
      reset_at: corroboration.corroborated ? resolved.reset_at : null,
      reason: corroboration.corroborated
        ? resolved.reason
        : `${resolved.reason ?? "signal received"} (awaiting corroboration before treating as ${resolved.status})`,
      signal_source: source,
      observed_at: now,
    });
  }
}
