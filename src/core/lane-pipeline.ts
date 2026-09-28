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
import { probeGrokLane } from "./signal-sources/active-probe/grok.js";
import { probeOllamaLane } from "./signal-sources/active-probe/ollama.js";
import {
  decideSignalSource,
  resolveWithCorroboration,
  DEFAULT_PASSIVE_STALENESS_MS,
  DEFAULT_PUBLIC_STATUS_STALENESS_MS,
} from "./signal-sources/escalation.js";
import { resolveStatus, type ErrorCode, type LaneStatusValue, type SignalSource } from "./status-model.js";
import type { StateStore } from "./state-store.js";
import type { Lane } from "./lane-registry.js";
import type { SensingMetrics } from "./telemetry/sensing-metrics.js";

export interface RefreshDeps {
  /** Injected clock — an ISO-8601 timestamp for "now". Never Date.now() internally. */
  now: () => string;
  /** Surfaces the last real agent response/error observed on this lane, or
   * null if nothing recent — the REQ-01 passive-observation input. Read once
   * per refresh; composeService() feeds it reported route outcomes
   * (heimdall#96) through a consume-once RouteOutcomeTracker. Returning null
   * falls through to public-status/active-probe. */
  lastPassiveResponse: (laneId: string) => ResponseLike | null;
  fetchImpl?: typeof fetch;
  /** PANT-824: monotonic milliseconds, for heimdall_probe_duration_seconds only. Defaults to performance.now(). */
  monotonicNowMs?: () => number;
}

/** What one sensing cycle concluded, before corroboration — the
 * heimdall_probes_total `source`/`result`/`error_code` labels. */
interface SenseOutcome {
  result: string;
  errorCode: string;
}

/** Which signal source a sensing cycle used, set BEFORE any adapter call so
 * the throw path still knows it. `unconfigured` = a lane with no credential,
 * resolved locally without an active probe. */
type SenseSource = SignalSource | "unconfigured";

// PANT-824: only cycles that make a network call to the provider (or its
// status page) are timed in heimdall_probe_duration_seconds. A passive read
// (a reported route outcome — heimdall#96) and an unconfigured lane resolve
// in-process in microseconds; timing them would drag the histogram toward
// zero and hide real probe latency.
const TIMED_SOURCES: ReadonlySet<SenseSource> = new Set<SenseSource>(["public_status", "active_probe"]);

/** The two provider-specific functions every ProviderSignalAdapter pair must
 * supply — everything else in LanePipeline is provider-agnostic. */
export interface ProviderAdapters {
  checkPublicStatus(fetchImpl?: typeof fetch): Promise<{ status: string; reason: string | null }>;
  probe(
    credential: string,
    fetchImpl?: typeof fetch,
  ): Promise<{
    status: LaneStatusValue;
    reset_at: string | null;
    reason: string | null;
    error_code?: ErrorCode | null;
  }>;
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

// No public-status/grok.ts — no confirmed machine-readable status feed found
// for xAI/Grok Code (see hdl-grok-signals's research-brief.md). Same honest
// always-up stub pattern as openrouterAdapters() and ollamaAdapters().
async function alwaysUpGrokPublicStatus(): Promise<{ status: "up"; reason: null }> {
  return { status: "up", reason: null };
}

export function grokAdapters(): ProviderAdapters {
  return { checkPublicStatus: alwaysUpGrokPublicStatus, probe: probeGrokLane };
}

// No public-status/ollama.ts — it's local infra, not a hosted service, so no
// status page exists to check. Same honest always-up stub pattern as
// openrouterAdapters().
async function alwaysUpOllamaPublicStatus(): Promise<{ status: "up"; reason: null }> {
  return { status: "up", reason: null };
}

export function ollamaAdapters(): ProviderAdapters {
  return { checkPublicStatus: alwaysUpOllamaPublicStatus, probe: probeOllamaLane };
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
    /** PANT-824: optional so existing callers/tests keep working; main.ts always passes the service-wide instance. */
    private readonly sensing?: SensingMetrics,
  ) {}

  async refresh(lane: Lane): Promise<void> {
    const monotonicNowMs = this.deps.monotonicNowMs ?? (() => performance.now());
    const startedMs = monotonicNowMs();
    const attempt: { source: SenseSource } = { source: "active_probe" };
    let outcome: SenseOutcome = { result: "error", errorCode: "exception" };
    try {
      outcome = await this.sense(lane, attempt);
    } finally {
      // Recorded on the throw path too — an adapter that throws is exactly
      // the "sensing silently broken" case these counters exist to expose.
      this.sensing?.recordProbe({
        lane: lane.lane_id,
        provider: lane.provider,
        source: attempt.source,
        result: outcome.result,
        errorCode: outcome.errorCode,
        durationSeconds: TIMED_SOURCES.has(attempt.source)
          ? Math.max(0, (monotonicNowMs() - startedMs) / 1000)
          : null,
      });
    }
  }

  private async sense(lane: Lane, attempt: { source: SenseSource }): Promise<SenseOutcome> {
    const now = this.deps.now();

    // heimdall#96: a passive observation waiting to be read (e.g. a reported
    // route outcome) is the freshest evidence about this lane there is, so it
    // decides the status ahead of the staleness-based choice below. Its
    // recorded "passive" row then makes the next refresh see a fresh passive
    // signal; with nothing new pending, that path falls back to a probe.
    const pending = observePassiveSignal(this.deps.lastPassiveResponse(lane.lane_id));
    if (pending) {
      attempt.source = "passive";
      return this.persistResolved(lane.lane_id, resolveStatus(pending), "passive", now);
    }

    const decision = decideSignalSource({
      now,
      passiveSignalAt: this.store.getLastObservedAt(lane.lane_id, "passive"),
      publicStatusSignalAt: this.store.getLastObservedAt(lane.lane_id, "public_status"),
      passiveStalenessMs: DEFAULT_PASSIVE_STALENESS_MS,
      publicStatusStalenessMs: DEFAULT_PUBLIC_STATUS_STALENESS_MS,
    });

    if (decision.action === "use-passive") {
      // Thought passive was fresh but there's nothing to observe (the
      // lastPassiveResponse read above came back empty) — defensive fallback
      // rather than trusting a null read.
      return this.refreshViaProbe(lane, now, attempt);
    }

    if (decision.action === "use-public-status") {
      attempt.source = "public_status";
      const signal = await this.adapters.checkPublicStatus(this.deps.fetchImpl);
      return this.persistResolved(lane.lane_id, resolveStatus(signal), "public_status", now);
    }

    return this.refreshViaProbe(lane, now, attempt);
  }

  private async refreshViaProbe(lane: Lane, now: string, attempt: { source: SenseSource }): Promise<SenseOutcome> {
    if (!lane.credential) {
      attempt.source = "unconfigured";
      // REQ-07: missing/invalid credential — report down/unconfigured, never crash.
      this.recordStatus({
        lane_id: lane.lane_id,
        status: "down",
        reset_at: null,
        reason: "unconfigured — no credential available for active probe",
        signal_source: "active_probe",
        observed_at: now,
      });
      return { result: "down", errorCode: "unconfigured" };
    }

    attempt.source = "active_probe";
    const probe = await this.adapters.probe(lane.credential, this.deps.fetchImpl);
    return this.persistResolved(lane.lane_id, resolveStatus(probe), "active_probe", now);
  }

  /** store.recordStatus plus heimdall_lane_status_transitions_total — the
   * one place this pipeline writes status, so every change it makes is
   * counted, whichever scheduler (or manual refresh) triggered it. A lane's
   * first-ever status counts as a transition from "none". */
  private recordStatus(entry: Parameters<StateStore["recordStatus"]>[0]): void {
    const from = this.store.hasRecordedStatus(entry.lane_id)
      ? (this.store.getCurrentStatus(entry.lane_id)?.status ?? "none")
      : "none";
    this.store.recordStatus(entry);
    if (from !== entry.status) {
      this.sensing?.recordStatusTransition(entry.lane_id, from, entry.status);
    }
  }

  private persistResolved(
    laneId: string,
    resolved: {
      status: LaneStatusValue;
      reset_at: string | null;
      reason: string | null;
      error_code?: ErrorCode | null;
    },
    source: SignalSource,
    now: string,
  ): SenseOutcome {
    const priorRawVerdict = this.lastRawVerdictByLane.get(laneId) ?? null;
    const corroboration = resolveWithCorroboration({
      latestVerdict: resolved.status,
      priorVerdict: priorRawVerdict,
    });
    this.lastRawVerdictByLane.set(laneId, resolved.status);

    // hdl-error-taxonomy fix: reset_at/error_code are diagnostic DETAIL, not
    // themselves a verdict — they used to be dropped (reset_at → null)
    // pending corroboration, discarding real timer/classification info for
    // a full extra cycle even though the underlying signal was real. Only
    // the STATUS stays conservative (downgraded to `degraded` until
    // corroborated) — "OUR state could be one of the 3 [suspect states] ...
    // but then with full details underneath" (operator, 2026-08-16).
    this.recordStatus({
      lane_id: laneId,
      status: corroboration.verdict,
      reset_at: resolved.reset_at,
      reason: corroboration.corroborated
        ? resolved.reason
        : `${resolved.reason ?? "signal received"} (awaiting corroboration before treating as ${resolved.status})`,
      error_code: resolved.error_code ?? null,
      signal_source: source,
      observed_at: now,
    });
    return { result: resolved.status, errorCode: resolved.error_code ?? "none" };
  }
}
