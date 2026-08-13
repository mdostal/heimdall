// End-to-end signal pipeline (lhs-03f Claude integration, generalized in
// lhs-04 to prove the ProviderSignalAdapter pattern actually holds across
// providers). Wires the independently-built pieces (lhs-03a passive core,
// per-provider public-status/active-probe adapters, lhs-03d escalation
// logic, lhs-03e resolution model) into one real pipeline, persisting
// through lhs-02's state-store.
//
// Originally written as a Claude-only `ClaudeLanePipeline` in lhs-03f; when
// lhs-04 needed the same pipeline for Codex, hardcoding Claude's adapter
// functions directly would have meant either duplicating this whole class
// or leaving lhs-04 unable to reuse it — exactly the interface friction
// lhs-04's design intent calls out ("gets fixed in status-model.ts/
// lane-registry.ts rather than special-cased per provider"). Generalized to
// `LanePipeline`, parameterized by a `ProviderAdapters` pair, so the same
// class serves every provider with zero per-provider branching inside it.
//
// LanePipeline.refresh() is meant to be invoked periodically by a scheduler
// (or on-demand) — NOT on every GET /lanes request, per the discovery
// brief's token-conscious design principle. GET /lanes (http-server.ts)
// just reads whatever this pipeline last persisted to the state-store.

import { observePassiveSignal, type ResponseLike } from "./signal-sources/passive.js";
import { checkClaudePublicStatus } from "./signal-sources/public-status/claude.js";
import { probeClaudeLane } from "./signal-sources/active-probe/claude.js";
import { checkCodexPublicStatus } from "./signal-sources/public-status/codex.js";
import { probeCodexLane } from "./signal-sources/active-probe/codex.js";
import { checkGeminiPublicStatus } from "./signal-sources/public-status/gemini.js";
import { probeGeminiLane } from "./signal-sources/active-probe/gemini.js";
import { checkKimiPublicStatus } from "./signal-sources/public-status/kimi.js";
import { probeKimiLane } from "./signal-sources/active-probe/kimi.js";
import { probeOpenRouterLane } from "./signal-sources/active-probe/openrouter.js";
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

/** The two provider-specific functions every ProviderSignalAdapter pair must
 * supply — everything else in LanePipeline is provider-agnostic. */
export interface ProviderAdapters {
  checkPublicStatus(fetchImpl?: typeof fetch): Promise<{ status: string; reason: string | null }>;
  probe(
    credential: string,
    fetchImpl?: typeof fetch,
  ): Promise<{ status: LaneStatusValue; reset_at: string | null; reason: string | null }>;
}

export function claudeAdapters(): ProviderAdapters {
  return { checkPublicStatus: checkClaudePublicStatus, probe: probeClaudeLane };
}

export function codexAdapters(): ProviderAdapters {
  return { checkPublicStatus: checkCodexPublicStatus, probe: probeCodexLane };
}

export function geminiAdapters(): ProviderAdapters {
  return { checkPublicStatus: checkGeminiPublicStatus, probe: probeGeminiLane };
}

export function kimiAdapters(): ProviderAdapters {
  return { checkPublicStatus: checkKimiPublicStatus, probe: probeKimiLane };
}

// No public-status/openrouter.ts exists — no confirmed machine-readable
// status feed was found for OpenRouter (see hdl-or-01's research-brief.md).
// An honest always-up stub, not an omitted field: ProviderAdapters requires
// both functions, and this is truthful about there being no real feed to
// check rather than fabricating one.
async function alwaysUpOpenRouterPublicStatus(): Promise<{ status: "up"; reason: null }> {
  return { status: "up", reason: null };
}

export function openrouterAdapters(): ProviderAdapters {
  return { checkPublicStatus: alwaysUpOpenRouterPublicStatus, probe: probeOpenRouterLane };
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
export class LanePipeline {
  private readonly lastRawVerdictByLane = new Map<string, LaneStatusValue>();

  constructor(
    private readonly store: StateStore,
    private readonly deps: RefreshDeps,
    private readonly adapters: ProviderAdapters,
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
      const signal = await this.adapters.checkPublicStatus(this.deps.fetchImpl);
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

    const probe = await this.adapters.probe(lane.credential, this.deps.fetchImpl);
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
