// MulticaRestClient — flaky-connection-hardened HTTP layer for Multica's real
// REST control API (hda-01). Multica does NOT run on this laptop: the real
// target is a separate instance on "the hive" at :8090 (co-located prod =
// http://localhost:8090; remote/dev = http://100.75.161.82:8090 via
// Tailscale) — MULTICA_BASE_URL is required config, no baked-in default,
// since hardcoding either host would be actively wrong depending on where
// Heimdall runs. MULTICA_WORKSPACE_ID is also required — every /api/agents
// and runtime call needs workspace scoping or Multica 400s with
// {"error":"workspace_id or workspace_slug is required"}.
//
// Every call resolves to a MulticaCallResult — NEVER throws — because the
// hive connection is known-flaky and a hung/failed call must not hang or
// crash Heimdall's sense loop. Two endpoint corrections vs. the source
// design doc's original (wrong) claims, verified against Multica's actual
// Go source (see .pHive/epics/hdl-actuation/docs/research-brief.md):
// `status` on PUT /api/agents/{id} is an internal derived enum, not a
// pause/active toggle; archive/restore cancels in-flight tasks, it is not a
// safe pause. The real actuation lever is max_concurrent_tasks.

import { EnvCredentialSource, type CredentialSource } from "../credential-source.js";

export type MulticaCallResult<T> =
  | { status: "ok"; data: T }
  | { status: "timeout" }
  | { status: "unreachable"; message: string }
  | { status: "http_error"; httpStatus: number; message: string };

export interface MulticaAgent {
  id: string;
  workspace_id: string;
  model?: string;
  max_concurrent_tasks: number;
  status: string;
  visibility: string;
  [key: string]: unknown;
}

export interface MulticaRuntime {
  id: string;
  workspace_id: string;
  status: string;
  provider?: string;
  last_seen_at?: string;
  [key: string]: unknown;
}

export interface AgentUpdatePatch {
  model?: string;
  max_concurrent_tasks?: number;
  status?: string;
  visibility?: string;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_TOKEN_REF = "MULTICA_PAT_TOKEN";

export interface MulticaRestClientOptions {
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  workspaceId?: string;
  credentialSource?: CredentialSource;
  /** credential_ref for the Bearer PAT — resolved via the existing CredentialSource abstraction, same pattern as lane credentials (REQ-07). */
  tokenRef?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class MulticaRestClient {
  private readonly baseUrl: string;
  private readonly workspaceId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MulticaRestClientOptions = {}) {
    const env = options.env ?? process.env;

    const baseUrl = options.baseUrl ?? env.MULTICA_BASE_URL;
    if (!baseUrl) {
      throw new Error(
        "MULTICA_BASE_URL is not configured — cannot construct a MulticaRestClient without a " +
          "base URL. This is deployment-specific (co-located on the hive: http://localhost:8090; " +
          "remote/dev: http://100.75.161.82:8090) and has no safe default.",
      );
    }

    const workspaceId = options.workspaceId ?? env.MULTICA_WORKSPACE_ID;
    if (!workspaceId) {
      throw new Error(
        "MULTICA_WORKSPACE_ID is not configured — every Multica API call requires workspace scoping.",
      );
    }

    const credentialSource = options.credentialSource ?? new EnvCredentialSource(env);
    const tokenRef = options.tokenRef ?? DEFAULT_TOKEN_REF;
    const token = credentialSource.resolve(tokenRef);
    if (!token) {
      throw new Error(
        `Multica PAT not resolved via credential_ref "${tokenRef}" — cannot authenticate to Multica.`,
      );
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.workspaceId = workspaceId;
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<MulticaCallResult<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("workspace_id", this.workspaceId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const errBody: unknown = await response.json();
          if (errBody && typeof errBody === "object" && "error" in errBody) {
            message = String((errBody as { error: unknown }).error);
          }
        } catch {
          // Body wasn't parseable JSON — keep the generic HTTP-status message.
        }
        return { status: "http_error", httpStatus: response.status, message };
      }

      const text = await response.text();
      const data = (text.length > 0 ? JSON.parse(text) : undefined) as T;
      return { status: "ok", data };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { status: "timeout" };
      }
      return {
        status: "unreachable",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  listAgents(): Promise<MulticaCallResult<MulticaAgent[]>> {
    return this.request<MulticaAgent[]>("GET", "/api/agents");
  }

  updateAgent(id: string, patch: AgentUpdatePatch): Promise<MulticaCallResult<MulticaAgent>> {
    return this.request<MulticaAgent>("PUT", `/api/agents/${encodeURIComponent(id)}`, {
      body: patch,
    });
  }

  archiveAgent(id: string): Promise<MulticaCallResult<void>> {
    return this.request<void>("POST", `/api/agents/${encodeURIComponent(id)}/archive`);
  }

  restoreAgent(id: string): Promise<MulticaCallResult<void>> {
    return this.request<void>("POST", `/api/agents/${encodeURIComponent(id)}/restore`);
  }

  listRuntimes(): Promise<MulticaCallResult<MulticaRuntime[]>> {
    return this.request<MulticaRuntime[]>("GET", "/api/runtimes");
  }

  patchRuntime(id: string, patch: Record<string, unknown>): Promise<MulticaCallResult<MulticaRuntime>> {
    return this.request<MulticaRuntime>("PATCH", `/api/runtimes/${encodeURIComponent(id)}`, {
      body: patch,
    });
  }
}
