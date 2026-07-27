// Lane declarations + credential resolution.
//
// Lanes are declared via HEIMDALL_LANE_<N>_{ID,PROVIDER,CREDENTIAL_REF}
// env-var triples (contiguous numbering starting at 1; loading stops at the
// first gap). credential_ref names a secret source, not the secret itself:
// a local env var by default, or `portunus:<reference>` when the Portunus
// broker is enabled. This separation lets a lane be known (declared) even
// when its credential fails to resolve, which is exactly what REQ-07
// requires: report down/unconfigured, don't crash, don't silently drop the
// lane.

import type { CredentialSource } from "./credential-source.js";

export interface LaneDeclaration {
  lane_id: string;
  provider: string;
  credential_ref: string;
  /** Optional broker policy/audit metadata; Portunus' current CLI resolves by reference name. */
  credential_scope?: string;
}

export interface Lane extends LaneDeclaration {
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
    const credentialScope = env[`HEIMDALL_LANE_${i}_CREDENTIAL_SCOPE`];
    if (!provider || !credentialRef) {
      // Malformed declaration (missing a required field) — skip this lane
      // rather than crashing the whole service.
      continue;
    }
    declarations.push({
      lane_id: laneId,
      provider,
      credential_ref: credentialRef,
      ...(credentialScope ? { credential_scope: credentialScope } : {}),
    });
  }
  return declarations;
}

export class LaneRegistry {
  private readonly lanes: Lane[];

  constructor(declarations: LaneDeclaration[], credentialSource: CredentialSource) {
    this.lanes = declarations.map((decl) => ({
      ...decl,
      credential: credentialSource.resolve(decl.credential_ref, decl.credential_scope),
    }));
  }

  list(): Lane[] {
    return this.lanes;
  }

  get(laneId: string): Lane | null {
    return this.lanes.find((lane) => lane.lane_id === laneId) ?? null;
  }
}
