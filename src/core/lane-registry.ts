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

export interface LaneDeclaration {
  lane_id: string;
  provider: string;
  credential_ref: string;
  model?: string;
  /** Optional operator-set rank override (hdl-or-04) — see routing-strategies/priority-strategy.ts. */
  priority?: number;
}

export interface Lane extends LaneDeclaration {
  model: string;
  /** Resolved secret, or null when the credential_ref didn't resolve (REQ-07: down/unconfigured). */
  credential: string | null;
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
    const rawPriority = env[`HEIMDALL_LANE_${i}_PRIORITY`];
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
    declarations.push({
      lane_id: laneId,
      provider,
      credential_ref: credentialRef,
      ...(model ? { model } : {}),
      ...(priority !== undefined ? { priority } : {}),
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
