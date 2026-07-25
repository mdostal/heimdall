// CredentialSource — REQ-07: minimal local credential loading for lane probes.
//
// `credential_ref` is a level of indirection (matches the `lanes.credential_ref`
// column in architecture.md's SQLite schema): it names WHERE to look up a
// secret, not the secret itself. This local .env-backed implementation is a
// deliberate Portunus stopgap (see .pHive/planning/product-brief.md P2) —
// callers depend only on this interface so swapping in Portunus later
// doesn't touch calling code.

export interface CredentialSource {
  resolve(credentialRef: string): string | null;
}

export class EnvCredentialSource implements CredentialSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  resolve(credentialRef: string): string | null {
    const value = this.env[credentialRef];
    return value !== undefined && value.length > 0 ? value : null;
  }
}
