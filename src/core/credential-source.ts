// CredentialSource — scoped secret lookup for lane probes and host adapters.
//
// `credential_ref` is a level of indirection (matches the `lanes.credential_ref`
// column in architecture.md's SQLite schema): it names WHERE to look up a
// secret, not the secret itself. Plain refs preserve REQ-07's local env
// stopgap; `portunus:<name>` refs go through Portunus' boundary resolver.

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

export const PORTUNUS_REF_PREFIX = "portunus:";
const LOCAL_SECRET_PREFIX = "HEIMDALL_LOCAL_SECRET_";

type ExecFileSync = typeof execFileSync;
type ReadFileSync = typeof readFileSync;
type UnlinkSync = typeof unlinkSync;

export interface CredentialSourceDeps {
  execFileSync?: ExecFileSync;
  readFileSync?: ReadFileSync;
  unlinkSync?: UnlinkSync;
}

export interface CredentialSource {
  resolve(credentialRef: string, credentialScope?: string): string | null;
}

export class EnvCredentialSource implements CredentialSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  resolve(credentialRef: string): string | null {
    const parsed = parseCredentialRef(credentialRef);
    const envRef =
      parsed.kind === "env" ? parsed.name : localStopgapEnvName(parsed.name);
    const value = this.env[envRef];
    return value !== undefined && value.length > 0 ? value : null;
  }
}

export class PortunusCredentialSource implements CredentialSource {
  private readonly execFileSync: ExecFileSync;
  private readonly readFileSync: ReadFileSync;
  private readonly unlinkSync: UnlinkSync;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    deps: CredentialSourceDeps = {},
  ) {
    this.execFileSync = deps.execFileSync ?? execFileSync;
    this.readFileSync = deps.readFileSync ?? readFileSync;
    this.unlinkSync = deps.unlinkSync ?? unlinkSync;
  }

  resolve(credentialRef: string): string | null {
    const parsed = parseCredentialRef(credentialRef);
    if (parsed.kind !== "portunus") return null;

    let tempPath: string | null = null;
    try {
      const output = this.execFileSync(
        this.env.PORTUNUS_BIN ?? "portunus",
        ["resolve", toPortunusPlaceholder(parsed.name)],
        { encoding: "utf8", env: this.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      tempPath = String(output).trim();
      if (!tempPath) return null;

      const value = this.readFileSync(tempPath, "utf8");
      return value.length > 0 ? value : null;
    } catch {
      return null;
    } finally {
      if (tempPath) {
        try {
          this.unlinkSync(tempPath);
        } catch {
          // Best-effort cleanup. Never include the temp path or resolved value
          // in logs from this boundary.
        }
      }
    }
  }
}

export class FallbackCredentialSource implements CredentialSource {
  constructor(private readonly sources: CredentialSource[]) {}

  resolve(credentialRef: string, credentialScope?: string): string | null {
    for (const source of this.sources) {
      const value = source.resolve(credentialRef, credentialScope);
      if (value) return value;
    }
    return null;
  }
}

export function buildCredentialSource(
  env: NodeJS.ProcessEnv = process.env,
  deps: CredentialSourceDeps = {},
): CredentialSource {
  if (env.HEIMDALL_SECRET_BROKER === "portunus") {
    return new FallbackCredentialSource([
      new PortunusCredentialSource(env, deps),
      new EnvCredentialSource(env),
    ]);
  }
  return new EnvCredentialSource(env);
}

export function isPortunusCredentialRef(credentialRef: string): boolean {
  return parseCredentialRef(credentialRef).kind === "portunus";
}

export function localStopgapEnvName(portunusRef: string): string {
  return `${LOCAL_SECRET_PREFIX}${portunusRef.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function toPortunusPlaceholder(portunusRef: string): string {
  return `{{secret:${portunusRef}}}`;
}

function parseCredentialRef(
  credentialRef: string,
): { kind: "env"; name: string } | { kind: "portunus"; name: string } {
  if (credentialRef.startsWith(PORTUNUS_REF_PREFIX)) {
    return { kind: "portunus", name: credentialRef.slice(PORTUNUS_REF_PREFIX.length) };
  }
  if (credentialRef.startsWith("env:")) {
    return { kind: "env", name: credentialRef.slice("env:".length) };
  }
  return { kind: "env", name: credentialRef };
}
