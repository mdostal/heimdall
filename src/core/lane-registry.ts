// Lane declarations + credential resolution.
//
// Lanes are declared via HEIMDALL_LANE_<N>_{ID,PROVIDER,CREDENTIAL_REF}
// env-var triples (contiguous numbering starting at 1; loading stops at the
// first gap). credential_ref names another env var holding the actual
// secret — see credential-source.ts. This separation lets a lane be known
// (declared) even when its credential fails to resolve, which is exactly
// what REQ-07 requires: report down/unconfigured, don't crash, don't
// silently drop the lane.

import type { CredentialSource } from "./credential-source.js";

export type LaneCostTier = "low" | "medium" | "high";

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
}

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

export class LaneRegistry {
  private readonly lanes: Lane[];

  constructor(declarations: LaneDeclaration[], credentialSource: CredentialSource) {
    this.lanes = declarations.map((decl) => ({
      ...decl,
      model: decl.model ?? decl.provider,
      headroom: decl.headroom ?? DEFAULT_HEADROOM,
      cost_tier: decl.cost_tier ?? DEFAULT_COST_TIER,
      credential: credentialSource.resolve(decl.credential_ref),
    }));
  }

  list(): Lane[] {
    return this.lanes;
  }

  get(laneId: string): Lane | null {
    return this.lanes.find((lane) => lane.lane_id === laneId) ?? null;
  }
}
