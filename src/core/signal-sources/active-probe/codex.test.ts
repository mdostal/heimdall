import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { interpretCodexCliFailure, probeCodexLane } from "./codex.js";
import { CodexHomeStore } from "./codex-home.js";
import type { CommandRunner, CommandRunOptions } from "../../scheduler/command-runner.js";

function fakeFetch(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const h = init?.headers as Record<string, string> | undefined;
    assert.ok(h?.authorization?.startsWith("Bearer "), "probe must send a Bearer auth header");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      headers: { get: (name: string) => headers[name] ?? null },
    } as unknown as Response;
  }) as typeof fetch;
}

test("a successful probe resolves to up", async () => {
  const result = await probeCodexLane("sk-fake", fakeFetch(200));
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null, error_code: null });
});

test("401/403 resolves to down (auth failure)", async () => {
  const result401 = await probeCodexLane("bad-key", fakeFetch(401));
  assert.equal(result401.status, "down");
  assert.equal(result401.error_code, "auth_failed");
  const result403 = await probeCodexLane("bad-key", fakeFetch(403));
  assert.equal(result403.status, "down");
});

test("429 with an insufficient_quota error code resolves to out_of_credit", async () => {
  const result = await probeCodexLane(
    "sk-fake",
    fakeFetch(429, { error: { code: "insufficient_quota", message: "You exceeded your quota" } }),
  );
  assert.equal(result.status, "out_of_credit");
  assert.equal(result.reason, "You exceeded your quota");
  assert.equal(result.error_code, "billing_error");
});

test("hdl-error-taxonomy: 429 with an organization_usage_limit_exceeded code resolves to out_of_credit/quota_exceeded, not billing_error", async () => {
  const result = await probeCodexLane(
    "sk-fake",
    fakeFetch(429, { error: { code: "organization_usage_limit_exceeded", message: "Organization usage limit reached" } }),
  );
  assert.equal(result.status, "out_of_credit");
  assert.equal(result.error_code, "quota_exceeded");
});

test("429 without a quota-specific code resolves to degraded (plain rate limit), reset_at converted to an absolute timestamp", async () => {
  const result = await probeCodexLane(
    "sk-fake",
    fakeFetch(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "30" }),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.error_code, "rate_limit");
  // hdl-error-taxonomy: CONFIRMED BUG FIX — this used to pass "30" straight
  // through (Date.parse("30") === NaN, silently discarded by the
  // scheduler). Now a real, parseable absolute ISO timestamp ~30s out.
  assert.ok(result.reset_at !== null && !Number.isNaN(Date.parse(result.reset_at)), `expected a real timestamp, got ${result.reset_at}`);
  const deltaMs = Date.parse(result.reset_at!) - Date.now();
  assert.ok(deltaMs > 25_000 && deltaMs < 35_000, `expected ~30s out, got ${deltaMs}ms`);
});

test("429 with a malformed (non-JSON) body still resolves to degraded, doesn't throw", async () => {
  const fetchImpl: typeof fetch = (async () =>
    ({
      ok: false,
      status: 429,
      json: async () => {
        throw new Error("not json");
      },
      headers: { get: () => null },
    }) as unknown as Response) as typeof fetch;
  const result = await probeCodexLane("sk-fake", fetchImpl);
  assert.equal(result.status, "degraded");
});

test("5xx resolves to down (server error)", async () => {
  const result = await probeCodexLane("sk-fake", fakeFetch(503));
  assert.equal(result.status, "down");
});

test("a network-level failure resolves to down rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await probeCodexLane("sk-fake", fetchImpl);
  assert.equal(result.status, "down");
});

test("uses the lightweight models-list endpoint, not a completion call", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
  }) as typeof fetch;
  await probeCodexLane("sk-fake", fetchImpl);
  assert.equal(calledUrl, "https://api.openai.com/v1/models");
});

// ---- PANT-694: ChatGPT-login credentials go through the real `codex` CLI ----

const SEED_AUTH_JSON = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: "eyJ.id.sig", access_token: "eyJ.access.sig", refresh_token: "rt_seed", account_id: "acct" },
  last_refresh: "2026-09-28T00:00:00Z",
});

// Captured from a real `codex exec` run (codex-cli 0.157.1, 2026-09-28)
// against a fabricated session: the 401 made the CLI try its refresh token.
const REAL_INVALID_SESSION_STDERR = [
  '2026-09-28T11:32:48.753007Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: Could not parse your authentication token. Please try signing in again.',
  "OpenAI Codex v0.157.1",
  '2026-09-28T11:32:48.937982Z ERROR codex_login::auth::manager: Failed to refresh token status=401 Unauthorized detail=TokenErrorDetail { error_code: Some("invalid_refresh_token"), error_message: Some("Could not validate your refresh token. Please try signing in again."), .. }',
  "ERROR: Reconnecting... 5/5",
  "ERROR: workspace routing discovery unauthorized (401)",
].join("\n");

function cliError(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Command failed: codex exec\n${stderr}`), { code: 1, stderr, stdout: "", ...extra });
}

function withStore(fn: (store: CodexHomeStore, root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "heimdall-codex-probe-"));
    try {
      await fn(new CodexHomeStore(root), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function recordingRunner(outcome: { stdout?: string; error?: Error }): CommandRunner & { calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> } {
  const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
  return {
    calls,
    run: async (command: string, args: string[], options?: CommandRunOptions) => {
      calls.push({ command, args, env: options?.env });
      if (outcome.error) throw outcome.error;
      return { stdout: outcome.stdout ?? "", stderr: "" };
    },
  };
}

const noFetch = (async () => {
  throw new Error("a ChatGPT-login credential must never be sent to api.openai.com");
}) as typeof fetch;

test("an auth.json credential is probed via `codex exec` in Heimdall's own CODEX_HOME, never over HTTP", withStore(async (store, root) => {
  const runner = recordingRunner({ stdout: "OK\n" });
  const result = await probeCodexLane(SEED_AUTH_JSON, noFetch, runner, store);
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null, error_code: null });
  assert.equal(runner.calls.length, 1);
  const { command, args, env } = runner.calls[0];
  assert.equal(command, "codex");
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--ephemeral") && args.includes("--ignore-user-config"));
  assert.equal(args.at(-1), "reply with the single word OK");
  assert.ok(env?.CODEX_HOME?.startsWith(root + path.sep), "CODEX_HOME must be Heimdall's own, never ~/.codex");
  assert.equal(readFileSync(path.join(env!.CODEX_HOME!, "auth.json"), "utf8"), SEED_AUTH_JSON);
}));

test("exit 0 with no reply is not proof of life", withStore(async (store) => {
  const result = await probeCodexLane(SEED_AUTH_JSON, noFetch, recordingRunner({ stdout: "  \n" }), store);
  assert.equal(result.status, "degraded");
}));

test("a dead session (the real refresh-token failure output) resolves to down/auth_failed with a re-provision hint", withStore(async (store) => {
  const runner = recordingRunner({ error: cliError(REAL_INVALID_SESSION_STDERR) });
  const result = await probeCodexLane(SEED_AUTH_JSON, noFetch, runner, store);
  assert.equal(result.status, "down");
  assert.equal(result.error_code, "auth_failed");
  assert.match(result.reason ?? "", /re-provision/);
  assert.match(result.reason ?? "", /invalid_refresh_token/);
  assert.doesNotMatch(result.reason ?? "", /Reconnecting/);
}));

test("a usage-limit reply resolves to out_of_credit with the stated reset time", () => {
  const now = new Date(2026, 8, 25, 12, 0);
  const result = interpretCodexCliFailure(
    cliError("ERROR: You've hit your usage limit. Upgrade to Pro or try again at Oct 13th, 2026 8:25 PM."),
    now,
  );
  assert.equal(result.status, "out_of_credit");
  assert.equal(result.error_code, "quota_exceeded");
  assert.equal(result.reset_at, new Date(2026, 9, 13, 20, 25).toISOString());
  assert.match(result.reason ?? "", /^You've hit your usage limit/);
});

test("a missing CLI or a timeout resolve to down with a specific reason", () => {
  const missing = interpretCodexCliFailure(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }), new Date());
  assert.equal(missing.status, "down");
  assert.match(missing.reason ?? "", /not installed/);
  const timedOut = interpretCodexCliFailure(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }), new Date());
  assert.equal(timedOut.error_code, "network_error");
});

test("a plain 401 without a refresh failure is auth_failed; a 429 is a transient rate limit", () => {
  const auth = interpretCodexCliFailure(cliError("ERROR: unexpected status 401 Unauthorized"), new Date());
  assert.equal(auth.error_code, "auth_failed");
  const rate = interpretCodexCliFailure(cliError("ERROR: unexpected status 429 Too Many Requests"), new Date());
  assert.equal(rate.status, "degraded");
  assert.equal(rate.error_code, "rate_limit");
});

test("an auth.json missing its refresh token is rejected without running the CLI", withStore(async (store) => {
  const runner = recordingRunner({ stdout: "OK" });
  const seed = JSON.stringify({ tokens: { id_token: "a", access_token: "b" } });
  const result = await probeCodexLane(seed, noFetch, runner, store);
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /tokens\.refresh_token is missing/);
  assert.equal(runner.calls.length, 0);
}));

test("a bare ChatGPT access token (JWT) is neither sent to api.openai.com nor to the CLI", withStore(async (store) => {
  const runner = recordingRunner({ stdout: "OK" });
  const result = await probeCodexLane("eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2ln", noFetch, runner, store);
  assert.equal(result.status, "down");
  assert.equal(result.error_code, "auth_failed");
  assert.match(result.reason ?? "", /bare ChatGPT access token/);
  assert.equal(runner.calls.length, 0);
}));
