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
import type { CredentialResolution, CredentialSource } from "./credential-source.js";

const DEFAULT_TIMEOUT_SECONDS = 10;
// PANT-932: resolution is a blocking call and is now retried while core-api is
// down, so an unreachable host must fail fast rather than hold the event loop
// for the full request timeout.
const CONNECT_TIMEOUT_SECONDS = 3;

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
    const resolution = this.resolveDetailed(credentialRef);
    return resolution.state === "resolved" ? resolution.value : null;
  }

  /**
   * PANT-932 (heimdall#116): classifies a failed fetch so callers can retry
   * the transient cases. After a host reboot Docker restarts every container
   * at once (restart policies ignore depends_on), so this first call can run
   * before core-api is listening.
   *
   *   - curl couldn't reach core-api at all (throws, or http_code 000):
   *     `unavailable`.
   *   - 5xx: `unavailable`. core-api's secrets facade answers 502 when its
   *     upstream (Portunus) call fails, which is what a still-booting
   *     Portunus looks like.
   *   - 4xx, or a 2xx whose file holds no value: `unconfigured`. core-api
   *     answered and no credential exists under this ref.
   */
  resolveDetailed(credentialRef: string): CredentialResolution {
    const filePath = path.join(this.sharedDir, `${this.generateId()}.secret`);
    try {
      let out: string;
      try {
        out = this.exec(
          "curl",
          [
            "-sS",
            "--connect-timeout",
            String(CONNECT_TIMEOUT_SECONDS),
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
      } catch (err) {
        return { state: "unavailable", detail: `core-api unreachable at ${this.baseUrl}: ${transportErrorDetail(err)}` };
      }

      const splitIdx = out.lastIndexOf("\n");
      const status = Number(splitIdx === -1 ? out : out.slice(splitIdx + 1));
      if (!Number.isFinite(status) || status === 0) {
        return { state: "unavailable", detail: `core-api unreachable at ${this.baseUrl}` };
      }
      if (status >= 500) {
        return { state: "unavailable", detail: `core-api secrets facade returned HTTP ${status}` };
      }
      if (!(status >= 200 && status < 300)) {
        return { state: "unconfigured" };
      }

      // Real, confirmed FileAdapter "env" format: `VALUE=<secret>\n` (see
      // adapters.py's own inject()). Parse it back out rather than
      // returning the raw file content verbatim.
      const content = this.readFile(filePath).trim();
      const eqIdx = content.indexOf("=");
      const value = eqIdx === -1 ? "" : content.slice(eqIdx + 1);
      return value.length > 0 ? { state: "resolved", value } : { state: "unconfigured" };
    } catch {
      // Matches EnvCredentialSource's own REQ-07 contract: never throws. A
      // 2xx whose file can't be read means core-api answered but nothing
      // usable was written -- treated as unconfigured, not retried.
      return { state: "unconfigured" };
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

/** curl's own stderr line (e.g. "curl: (7) Failed to connect to core-api:3012 ...") when
 * execFileSync attached it, else the error message. Never contains the secret: the request
 * body only carries the credential_ref and a file path. */
function transportErrorDetail(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = stderr != null ? String(stderr).trim() : "";
  if (text) return text.split("\n")[0];
  return err instanceof Error ? err.message : String(err);
}
