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

export const DEFAULT_LANE_HEADROOM = 10000;
export const DEFAULT_LANE_COST_TIER = "medium";
export const LANE_COST_TIERS = ["low", "medium", "high"] as const;

export type LaneCostTier = (typeof LANE_COST_TIERS)[number];

export interface LaneDeclaration {
  lane_id: string;
  provider: string;
  credential_ref: string;
  model?: string;
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

function parseOptionalHeadroom(value: string | undefined, laneId: string, envKey: string): number | null | undefined {
  if (value === undefined || value.trim() === "") return undefined;

  const headroom = Number(value);
  if (!Number.isFinite(headroom) || headroom < 0) {
    console.warn(`Skipping lane ${laneId}: ${envKey} must be a finite non-negative number`);
    return null;
  }

  return headroom;
}

function parseOptionalCostTier(value: string | undefined, laneId: string, envKey: string): LaneCostTier | null | undefined {
  if (value === undefined || value.trim() === "") return undefined;

  if (!LANE_COST_TIERS.includes(value as LaneCostTier)) {
    console.warn(`Skipping lane ${laneId}: ${envKey} must be one of ${LANE_COST_TIERS.join("|")}`);
    return null;
  }

  return value as LaneCostTier;
}

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
    if (!provider || !credentialRef) {
      // Malformed declaration (missing a required field) — skip this lane
      // rather than crashing the whole service.
      continue;
    }

    const headroom = parseOptionalHeadroom(env[`HEIMDALL_LANE_${i}_HEADROOM`], laneId, `HEIMDALL_LANE_${i}_HEADROOM`);
    const costTier = parseOptionalCostTier(env[`HEIMDALL_LANE_${i}_COST_TIER`], laneId, `HEIMDALL_LANE_${i}_COST_TIER`);
    if (headroom === null || costTier === null) {
      continue;
    }

    declarations.push({
      lane_id: laneId,
      provider,
      credential_ref: credentialRef,
      ...(model ? { model } : {}),
      ...(headroom !== undefined ? { headroom } : {}),
      ...(costTier !== undefined ? { cost_tier: costTier } : {}),
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
      headroom: decl.headroom ?? DEFAULT_LANE_HEADROOM,
      cost_tier: decl.cost_tier ?? DEFAULT_LANE_COST_TIER,
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
