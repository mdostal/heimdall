// MulticaControlAdapter — idempotent, partial-failure-tolerant real
// actuation (hda-03). Uses the verified, non-destructive lever
// (max_concurrent_tasks), never the source doc's original (wrong) status/
// archive proposal — see multica-rest-client.ts's header for the correction.
//
// reconcile() is called every sense-loop tick for every lane (ControlAdapter
// contract). For each mapped agent, it compares desired state (derived from
// current lane status) against the last-successfully-applied state tracked
// in-process. A match is a true no-op — no API call at all. A mismatch —
// because status genuinely changed, OR because the last attempt failed and
// never got applied — triggers exactly one API call attempt. This is what
// makes retry "for free": a failed attempt simply leaves the mismatch in
// place, and the next tick's reconcile() call retries automatically, with
// no bespoke retry bookkeeping.
//
// Per-agent: a failure on one agent in a lane's mapping is logged (via
// Argus) and does not block or roll back the others (log-and-continue,
// no atomic/rollback — Multica's REST API doesn't support transactions
// across separate PUT calls, and rolling back a disable would re-enable
// into a still-unhealthy lane).

import type { ControlAdapter, ReconcileContext } from "./control-adapter.js";
import type { Lane } from "../lane-registry.js";
import type { LaneStatusValue } from "../status-model.js";
import type { LaneAgentResolver } from "./lane-agent-resolver.js";
import { MulticaRestClient, type MulticaCallResult } from "./multica-rest-client.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { ArgusEmitter } from "../telemetry/argus-client.js";

const SUSPECT_STATUSES = new Set<LaneStatusValue>(["down", "degraded", "out_of_credit"]);

interface AgentState {
  /** null = never successfully applied yet (or forgotten after a restart — accepted tradeoff, same as lane-pipeline.ts's corroboration Map). */
  lastAppliedEnabled: boolean | null;
  /** The agent's max_concurrent_tasks value captured just before the first disable, so recovery restores the exact prior value rather than an arbitrary number. */
  priorMaxConcurrentTasks: number | null;
}

export interface MulticaControlAdapterOptions {
  restClient: MulticaRestClient;
  circuitBreaker: CircuitBreaker;
  resolver: LaneAgentResolver;
  argus: ArgusEmitter;
  /** Fallback re-enable value if a prior max_concurrent_tasks was never captured (e.g. an agent starts out already disabled for other reasons). */
  defaultEnabledConcurrency?: number;
}

const DEFAULT_ENABLED_CONCURRENCY = 1;

export class MulticaControlAdapter implements ControlAdapter {
  private readonly agentState = new Map<string, AgentState>();
  private readonly defaultEnabledConcurrency: number;

  constructor(private readonly opts: MulticaControlAdapterOptions) {
    this.defaultEnabledConcurrency = opts.defaultEnabledConcurrency ?? DEFAULT_ENABLED_CONCURRENCY;
  }

  async reconcile(lane: Lane, status: LaneStatusValue, context?: ReconcileContext): Promise<void> {
    const agentIds = this.opts.resolver.resolve(lane.lane_id);
    // hdl-lo-01: a manual override, when set, wins outright over the sensed
    // status — this is the SAME top-level gate the operator directed
    // traffic through before, not a second/parallel mechanism. Unset
    // (null/undefined, the default) is byte-identical to pre-hdl-lo-01
    // behavior: status alone decides.
    const desiredEnabled =
      context?.manualOverride != null
        ? context.manualOverride === "enabled"
        : !SUSPECT_STATUSES.has(status);

    for (const agentId of agentIds) {
      await this.reconcileAgent(lane, agentId, desiredEnabled, context);
    }
  }

  private async reconcileAgent(
    lane: Lane,
    agentId: string,
    desiredEnabled: boolean,
    context: ReconcileContext | undefined,
  ): Promise<void> {
    const state = this.agentState.get(agentId) ?? {
      lastAppliedEnabled: null,
      priorMaxConcurrentTasks: null,
    };

    if (state.lastAppliedEnabled === desiredEnabled) {
      return; // Idempotent no-op — already in the desired state, no API call.
    }

    if (desiredEnabled) {
      await this.enableAgent(lane, agentId, state, context);
    } else {
      await this.disableAgent(lane, agentId, state, context);
    }
  }

  private async disableAgent(
    lane: Lane,
    agentId: string,
    state: AgentState,
    context: ReconcileContext | undefined,
  ): Promise<void> {
    if (state.priorMaxConcurrentTasks === null) {
      const listResult = await this.callViaBreaker(() => this.opts.restClient.listAgents());
      if (listResult.status !== "ok") {
        this.emitResult(lane, agentId, "capture-prior-state", false, listResult.status, context);
        return; // Retried automatically next tick — mismatch is still in place.
      }
      const agent = listResult.data.find((a) => a.id === agentId);
      if (!agent) {
        this.emitResult(lane, agentId, "capture-prior-state", false, "agent_not_found", context);
        return;
      }
      state.priorMaxConcurrentTasks = agent.max_concurrent_tasks;
      this.agentState.set(agentId, state);
    }

    const updateResult = await this.callViaBreaker(() =>
      this.opts.restClient.updateAgent(agentId, { max_concurrent_tasks: 0 }),
    );
    const success = updateResult.status === "ok";
    this.emitResult(lane, agentId, "disable", success, success ? undefined : updateResult.status, context);
    if (success) {
      state.lastAppliedEnabled = false;
      this.agentState.set(agentId, state);
    }
  }

  private async enableAgent(
    lane: Lane,
    agentId: string,
    state: AgentState,
    context: ReconcileContext | undefined,
  ): Promise<void> {
    const restoreValue = state.priorMaxConcurrentTasks ?? this.defaultEnabledConcurrency;
    const updateResult = await this.callViaBreaker(() =>
      this.opts.restClient.updateAgent(agentId, { max_concurrent_tasks: restoreValue }),
    );
    const success = updateResult.status === "ok";
    this.emitResult(lane, agentId, "enable", success, success ? undefined : updateResult.status, context);
    if (success) {
      state.lastAppliedEnabled = true;
      this.agentState.set(agentId, state);
    }
  }

  private async callViaBreaker<T>(
    fn: () => Promise<MulticaCallResult<T>>,
  ): Promise<MulticaCallResult<T> | { status: "circuit_open" }> {
    const outcome = await this.opts.circuitBreaker.call(fn, (r) => r.status === "ok");
    if (outcome.circuitOpen) {
      return { status: "circuit_open" };
    }
    return outcome.result;
  }

  private emitResult(
    lane: Lane,
    agentId: string,
    action: string,
    success: boolean,
    /** Reason for THIS action's outcome (e.g. an API error code) — distinct from `context.reason`, which is why the LANE is in its current status. */
    outcomeReason?: string,
    context?: ReconcileContext,
  ): void {
    this.opts.argus.emitActuationResult({
      laneId: lane.lane_id,
      provider: lane.provider,
      agentId,
      action,
      success,
      reason: outcomeReason,
      laneReason: context?.reason ?? undefined,
      laneResetAt: context?.reset_at ?? undefined,
      overrideActive: context?.manualOverride != null,
    });
  }
}
