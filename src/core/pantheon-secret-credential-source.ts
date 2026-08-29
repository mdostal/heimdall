// PantheonSecretCredentialSource — the real implementation
// heimdall/docs/decisions/DEC-hdl-portunus-deferral.md itself names as the
// target shape once its named prerequisite (a real Pantheon Core
// request/response mechanism for secrets) exists: "a
// PantheonSecretCredentialSource that calls through [it]... discovering
// Portunus via its L2 descriptor, never a direct CLI/HTTP dependency on
// Portunus's implementation details."
//
// This class NEVER talks to Portunus directly (no `portunus` CLI shell-out,
// no HTTP call to Portunus's own port) -- it calls ONLY Pantheon Core's real
// secrets facade (pantheon-v2's core/api/secrets.ts, POST
// /api/secrets/inject). That facade discovers and calls Portunus on this
// class's behalf, preserving the exact boundary the earlier, rejected
// PAN-5599 attempt violated.
//
// CredentialSource.resolve() is a SYNCHRONOUS interface (LaneRegistry's own
// constructor calls it directly, not awaited -- see lane-registry.ts) but
// Pantheon's facade is a real HTTP call. Solved the same way this whole
// program already solved an identical sync-vs-network tension tonight
// (Auriga's pantheon-v2-l2 adapter, execFileSync against curl): a real,
// blocking child-process call, injected for testability.
//
// Value-retrieval mechanism: Pantheon's secrets facade (matching Portunus's
// own non-disclosure model) never returns a raw secret value in an HTTP
// response body -- POST /api/secrets/inject only resolves and injects into
// a TARGET. For an env-var target, that target is the injecting process's
// OWN child process, which isn't useful here (Heimdall needs the value in
// its own process to build a probe request). This class therefore uses
// `target: 'file'`, writing to a path on a REAL SHARED VOLUME between
// Portunus's container and wherever this process runs (see
// PANTHEON_SECRETS_SHARED_DIR below) -- Portunus's own gated process
// writes the file; this class reads it (a local file read, not a network
// round-trip of the value), then deletes it immediately. The shared-volume
// wiring itself is real infrastructure this epic's story C / live
// verification step must provision and confirm, not assumed here.

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CredentialSource } from "./credential-source.js";

const DEFAULT_TIMEOUT_SECONDS = 10;

export interface PantheonSecretCredentialSourceOptions {
  /** Pantheon Core's real address. Defaults to PANTHEON_API_URL (matching this program's
   * established convention for every cross-god HTTP call), then the compose-network
   * hostname. */
  pantheonApiUrl?: string;
  /** The real shared-volume directory both this process and Portunus's container can read/
   * write. Defaults to PANTHEON_SECRETS_SHARED_DIR. Must exist and be genuinely shared --
   * this class does not create or mount it. */
  sharedSecretsDir?: string;
  /** Injected for testability -- avoids a real child process / real filesystem in tests. */
  exec?: (cmd: string, args: string[], opts: object) => string;
  readFile?: (path: string) => string;
  deleteFile?: (path: string) => void;
  /** Injected for testability -- avoids a real random id in tests. */
  generateId?: () => string;
}

export class PantheonSecretCredentialSource implements CredentialSource {
  private readonly baseUrl: string;
  private readonly sharedDir: string;
  private readonly exec: (cmd: string, args: string[], opts: object) => string;
  private readonly readFile: (path: string) => string;
  private readonly deleteFile: (path: string) => void;
  private readonly generateId: () => string;

  constructor(options: PantheonSecretCredentialSourceOptions = {}) {
    this.baseUrl = (options.pantheonApiUrl ?? process.env.PANTHEON_API_URL ?? "http://core-api:3012").replace(
      /\/+$/,
      "",
    );
    this.sharedDir = options.sharedSecretsDir ?? process.env.PANTHEON_SECRETS_SHARED_DIR ?? "/pantheon-secrets";
    this.exec = options.exec ?? ((cmd, args, opts) => execFileSync(cmd, args, opts).toString());
    this.readFile = options.readFile ?? ((p) => readFileSync(p, "utf8"));
    this.deleteFile = options.deleteFile ?? ((p) => unlinkSync(p));
    this.generateId = options.generateId ?? randomUUID;
  }

  resolve(credentialRef: string): string | null {
    const filePath = path.join(this.sharedDir, `${this.generateId()}.secret`);
    try {
      const out = this.exec(
        "curl",
        [
          "-sS",
          "--max-time",
          String(DEFAULT_TIMEOUT_SECONDS),
          "-X",
          "POST",
          `${this.baseUrl}/api/secrets/inject`,
          "-H",
          "content-type: application/json",
          "-d",
          // Portunus's real FileAdapter (adapters.py) requires format in
          // {"env","json","yaml"} and a non-empty key -- there is no bare
          // "raw value" format (confirmed by reading the adapter directly,
          // not assumed). "env" + key "VALUE" produces a single real line,
          // `VALUE=<secret>\n`, parsed back out below.
          JSON.stringify({ tags: credentialRef, target: "file", path: filePath, format: "env", key: "VALUE" }),
          "-w",
          "\n%{http_code}",
        ],
        { encoding: "utf8" },
      );

      const splitIdx = out.lastIndexOf("\n");
      const status = Number(splitIdx === -1 ? out : out.slice(splitIdx + 1));
      if (!(status >= 200 && status < 300)) {
        return null;
      }

      // Real, confirmed FileAdapter "env" format: `VALUE=<secret>\n` (see
      // adapters.py's own inject()). Parse it back out rather than
      // returning the raw file content verbatim.
      const content = this.readFile(filePath).trim();
      const eqIdx = content.indexOf("=");
      const value = eqIdx === -1 ? "" : content.slice(eqIdx + 1);
      return value.length > 0 ? value : null;
    } catch {
      // Matches EnvCredentialSource's own REQ-07 contract: resolve() never throws, a missing/
      // unreachable/failed resolution is a real, valid "null" outcome, not a crash.
      return null;
    } finally {
      try {
        this.deleteFile(filePath);
      } catch {
        // Best-effort cleanup -- a delete failure (e.g. file was never written because the
        // request failed before Portunus wrote it) must never mask the real resolve() outcome.
      }
    }
  }
}
