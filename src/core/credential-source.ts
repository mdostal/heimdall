// CredentialSource — REQ-07: minimal local credential loading for lane probes.
//
// `credential_ref` is a level of indirection (matches the `lanes.credential_ref`
// column in architecture.md's SQLite schema): it names WHERE to look up a
// secret, not the secret itself. This local .env-backed implementation is a
// deliberate Portunus stopgap (see .pHive/planning/product-brief.md P2) —
// callers depend only on this interface so swapping in Portunus later
// doesn't touch calling code.

/**
 * PANT-932 (heimdall#116): why a resolution produced no value matters. A
 * credential that doesn't exist (`unconfigured`) is final until the operator
 * registers one; a credential source that couldn't be reached (`unavailable`,
 * e.g. Pantheon core-api still booting after a host reboot) is transient and
 * worth retrying. Collapsing both into null is what left every lane
 * unconfigured forever after a reboot.
 */
export type CredentialResolution =
  | { state: "resolved"; value: string }
  | { state: "unconfigured" }
  | { state: "unavailable"; detail: string };

export interface CredentialSource {
  resolve(credentialRef: string): string | null;
  /** Optional richer form of resolve(). Sources that can't tell "missing" from
   * "unreachable" (e.g. a local env lookup, which is never unreachable) omit it. */
  resolveDetailed?(credentialRef: string): CredentialResolution;
}

/** resolveDetailed() when the source supports it, else resolve() mapped onto
 * resolved/unconfigured. Never throws — REQ-07. */
export function resolveCredential(source: CredentialSource, credentialRef: string): CredentialResolution {
  try {
    if (source.resolveDetailed) return source.resolveDetailed(credentialRef);
    const value = source.resolve(credentialRef);
    return value !== null ? { state: "resolved", value } : { state: "unconfigured" };
  } catch (err) {
    return { state: "unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
}

export class EnvCredentialSource implements CredentialSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  resolve(credentialRef: string): string | null {
    const value = this.env[credentialRef];
    return value !== undefined && value.length > 0 ? value : null;
  }
}
