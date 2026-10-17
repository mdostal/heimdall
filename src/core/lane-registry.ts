// Lane declarations + credential resolution.
//
// Lanes are declared via HEIMDALL_LANE_<N>_{ID,PROVIDER,CREDENTIAL_REF}
// env-var triples (contiguous numbering starting at 1; loading stops at the
// first gap). credential_ref names another env var holding the actual
// secret — see credential-source.ts. This separation lets a lane be known
// (declared) even when its credential fails to resolve, which is exactly
// what REQ-07 requires: report down/unconfigured, don't crash, don't
// silently drop the lane.

import { resolveCredential, type CredentialSource } from "./credential-source.js";

export type LaneCostTier = "low" | "medium" | "high";

/**
 * PANT-932 (heimdall#116): why a lane does or doesn't hold a credential.
 * `unconfigured` = no credential registered under credential_ref (final
 * until the operator adds one). `credential_unavailable` = the credential
 * source couldn't be reached (transient, e.g. core-api still booting after a
 * host reboot) — the registry keeps retrying these, see retryCredential().
 */
export type CredentialState = "resolved" | "unconfigured" | "credential_unavailable";

export interface LaneDeclaration {
  lane_id: string;
  provider: string;
  credential_ref: string;
  model?: string;
  /** Optional operator-set rank override (hdl-or-04) — see routing-strategies/priority-strategy.ts. */
  priority?: number;
  /** Optional scoring inputs (hdl-rr-03) — see routing-strategies/scored-strategy.ts. Defaulted on Lane when unset. */
  headroom?: number;
  cost_tier?: LaneCostTier;
}

export interface Lane extends LaneDeclaration {
  model: string;
  headroom: number;
  cost_tier: LaneCostTier;
  /** Resolved secret, or null when the credential_ref didn't resolve (REQ-07: down/unconfigured). */
  credential: string | null;
  credential_state: CredentialState;
  /** Last credential_unavailable detail (never the secret), null otherwise. */
  credential_detail: string | null;
}

/** Re-resolution backoff for credential_unavailable lanes: 1s, 2s, 4s ... capped at 30s,
 * and never given up on — a reboot can leave core-api down far longer than any fixed
 * deadline (heimdall#116: 34 minutes between host boot and Colima start). */
export const CREDENTIAL_RETRY_BASE_MS = 1_000;
export const CREDENTIAL_RETRY_MAX_MS = 30_000;

const DEFAULT_HEADROOM = 10000;
const DEFAULT_COST_TIER: LaneCostTier = "medium";
const COST_TIERS: readonly LaneCostTier[] = ["low", "medium", "high"];

export function loadLaneDeclarations(
  env: NodeJS.ProcessEnv = process.env,
): LaneDeclaration[] {
  const declarations: LaneDeclaration[] = [];
  for (let i = 1; ; i++) {
    const laneId = env[`HEIMDALL_LANE_${i}_ID`];
    if (!laneId) break; // contiguous numbering; stop at the first gap

    const provider = env[`HEIMDALL_LANE_${i}_PROVIDER`];
    const credentialRef = env[`HEIMDALL_LANE_${i}_CREDENTIAL_REF`];
    const model = env[`HEIMDALL_LANE_${i}_MODEL`];
    const rawPriority = env[`HEIMDALL_LANE_${i}_PRIORITY`];
    const rawHeadroom = env[`HEIMDALL_LANE_${i}_HEADROOM`];
    const rawCostTier = env[`HEIMDALL_LANE_${i}_COST_TIER`];
    if (!provider || !credentialRef) {
      // Malformed declaration (missing a required field) — skip this lane
      // rather than crashing the whole service.
      continue;
    }
    // hdl-or-04: an invalid priority value (non-numeric, negative, non-integer)
    // falls back to unset rather than crashing lane loading for the whole
    // service — same defensive posture as every other field in this loop.
    const parsedPriority = rawPriority !== undefined ? Number(rawPriority) : undefined;
    const priority =
      parsedPriority !== undefined && Number.isInteger(parsedPriority) && parsedPriority >= 0
        ? parsedPriority
        : undefined;

    // hdl-rr-03: unlike priority, an explicitly-declared but invalid
    // headroom/cost_tier skips the WHOLE lane (ported from dev's original
    // contract) — a scoring input the operator got visibly wrong is treated
    // as a malformed declaration, not silently defaulted away.
    if (rawHeadroom !== undefined) {
      const parsedHeadroom = Number(rawHeadroom);
      if (!Number.isFinite(parsedHeadroom) || parsedHeadroom < 0) {
        console.warn(`HEIMDALL_LANE_${i}_HEADROOM must be a finite non-negative number, got "${rawHeadroom}" — skipping lane ${laneId}`);
        continue;
      }
    }
    if (rawCostTier !== undefined && !COST_TIERS.includes(rawCostTier as LaneCostTier)) {
      console.warn(`HEIMDALL_LANE_${i}_COST_TIER must be one of low|medium|high, got "${rawCostTier}" — skipping lane ${laneId}`);
      continue;
    }

    declarations.push({
      lane_id: laneId,
      provider,
      credential_ref: credentialRef,
      ...(model ? { model } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(rawHeadroom !== undefined ? { headroom: Number(rawHeadroom) } : {}),
      ...(rawCostTier !== undefined ? { cost_tier: rawCostTier as LaneCostTier } : {}),
    });
  }
  return declarations;
}

export interface LaneRegistryOptions {
  /** Injected clock (epoch ms) for the credential retry backoff. Defaults to Date.now. */
  nowMs?: () => number;
}

export class LaneRegistry {
  private readonly lanes: Lane[];
  private readonly nowMs: () => number;
  private readonly retryState = new Map<string, { attempts: number; nextAttemptAtMs: number }>();

  constructor(
    declarations: LaneDeclaration[],
    private readonly credentialSource: CredentialSource,
    options: LaneRegistryOptions = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now;
    this.lanes = declarations.map((decl) => {
      const lane: Lane = {
        ...decl,
        model: decl.model ?? decl.provider,
        headroom: decl.headroom ?? DEFAULT_HEADROOM,
        cost_tier: decl.cost_tier ?? DEFAULT_COST_TIER,
        credential: null,
        credential_state: "unconfigured",
        credential_detail: null,
      };
      this.applyResolution(lane);
      return lane;
    });
  }

  list(): Lane[] {
    return this.lanes;
  }

  get(laneId: string): Lane | null {
    return this.lanes.find((lane) => lane.lane_id === laneId) ?? null;
  }

  /**
   * PANT-932: re-resolve a credential_unavailable lane's credential, updating
   * the Lane object IN PLACE (schedulers, pipelines and rotation views hold
   * references to it). Throttled by an exponential backoff per lane, so a
   * probe tick every few seconds doesn't turn into a blocking curl every few
   * seconds. No-op for resolved and unconfigured lanes. Returns true when the
   * lane now holds a credential.
   */
  retryCredential(laneId: string): boolean {
    const lane = this.get(laneId);
    if (!lane) return false;
    if (lane.credential_state !== "credential_unavailable") return lane.credential !== null;
    const retry = this.retryState.get(laneId);
    if (retry && this.nowMs() < retry.nextAttemptAtMs) return false;
    if (this.applyResolution(lane) === "resolved") {
      console.log(`[lane-registry] credential for lane ${lane.lane_id} resolved after credential source recovered.`);
    }
    return lane.credential !== null;
  }

  private applyResolution(lane: Lane): CredentialState {
    const resolution = resolveCredential(this.credentialSource, lane.credential_ref);
    switch (resolution.state) {
      case "resolved":
        lane.credential = resolution.value;
        lane.credential_state = "resolved";
        lane.credential_detail = null;
        this.retryState.delete(lane.lane_id);
        return lane.credential_state;
      case "unconfigured":
        lane.credential = null;
        lane.credential_state = "unconfigured";
        lane.credential_detail = null;
        this.retryState.delete(lane.lane_id);
        return lane.credential_state;
      case "unavailable": {
        lane.credential = null;
        lane.credential_state = "credential_unavailable";
        lane.credential_detail = resolution.detail;
        const attempts = (this.retryState.get(lane.lane_id)?.attempts ?? 0) + 1;
        const delayMs = Math.min(CREDENTIAL_RETRY_MAX_MS, CREDENTIAL_RETRY_BASE_MS * 2 ** (attempts - 1));
        this.retryState.set(lane.lane_id, { attempts, nextAttemptAtMs: this.nowMs() + delayMs });
        return lane.credential_state;
      }
    }
  }
}
