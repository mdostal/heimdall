// CodexHomeStore — Heimdall's OWN private CODEX_HOME for each ChatGPT-login
// codex lane (PANT-694).
//
// Why a private, persistent home rather than handing the CLI the credential
// per call (Claude's CLAUDE_CODE_OAUTH_TOKEN pattern): Codex's ChatGPT login
// is a session FILE ($CODEX_HOME/auth.json: id_token + access_token +
// refresh_token), and the CLI refreshes it on its own and rotates the refresh
// token. Confirmed live against codex-cli 0.157.1 (2026-09-28): on a 401 from
// chatgpt.com the CLI immediately POSTs the refresh_token, and a refresh
// token can only be spent once ("refresh token was already used"). So:
//
// - Two consumers of the SAME session (Heimdall's probe and Multica's own
//   task-dispatch runtime) race each other's refreshes. That can't be fixed
//   here, only avoided: the seed Heimdall receives must come from its OWN
//   `codex login`, never a copy of another runtime's ~/.codex/auth.json.
// - Re-writing auth.json from the (never-updated) seed on every probe would
//   hand the CLI a refresh token it already spent after its first rotation.
//   So the seed is written ONCE into a home keyed by the seed's hash, and
//   from then on the CLI owns that file. Re-provisioning (a new login, so a
//   new seed) gets a new home automatically.
// - Probes of the same home are serialized, so Heimdall never races itself.
//
// The root dir should be a persistent volume: if it is wiped, the seed is
// re-written, and if the CLI had already rotated it the lane reports an
// auth failure until the credential is re-provisioned.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexHomeFs {
  exists(p: string): boolean;
  mkdir(p: string): void;
  writeFile(p: string, contents: string): void;
}

const nodeFs: CodexHomeFs = {
  exists: (p) => existsSync(p),
  mkdir: (p) => mkdirSync(p, { recursive: true, mode: 0o700 }),
  // "wx" so a concurrent Heimdall process that seeded the same home first
  // wins, rather than having its (possibly already rotated) file clobbered.
  writeFile: (p, contents) => {
    try {
      writeFileSync(p, contents, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  },
};

export function defaultCodexHomeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEIMDALL_CODEX_HOME_ROOT ?? path.join(env.HEIMDALL_HOME ?? path.join(os.homedir(), ".heimdall"), "codex");
}

export interface PreparedCodexHome {
  /** Value for CODEX_HOME — holds this lane's auth.json. */
  home: string;
  /** An empty directory for the CLI's `-C` working root, kept apart from auth.json. */
  workdir: string;
}

export class CodexHomeStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string = defaultCodexHomeRoot(),
    private readonly fs: CodexHomeFs = nodeFs,
  ) {}

  /** Runs `fn` with this seed's home prepared, one call per home at a time. */
  async withHome<T>(seedAuthJson: string, fn: (prepared: PreparedCodexHome) => Promise<T>): Promise<T> {
    const prepared = this.prepare(seedAuthJson);
    const prior = this.locks.get(prepared.home) ?? Promise.resolve();
    const run = prior.then(
      () => fn(prepared),
      () => fn(prepared),
    );
    const settled = run.catch(() => undefined);
    this.locks.set(prepared.home, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(prepared.home) === settled) this.locks.delete(prepared.home);
    }
  }

  private prepare(seedAuthJson: string): PreparedCodexHome {
    const key = createHash("sha256").update(seedAuthJson).digest("hex").slice(0, 16);
    const home = path.join(this.root, key);
    const workdir = path.join(home, "workdir");
    this.fs.mkdir(workdir);
    const authPath = path.join(home, "auth.json");
    if (!this.fs.exists(authPath)) {
      this.fs.writeFile(authPath, seedAuthJson);
    }
    return { home, workdir };
  }
}
