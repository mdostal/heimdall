import { test } from "node:test";
import assert from "node:assert/strict";
import { probeClaudeLane, probeClaudeSubscriptionLane } from "./claude.js";
import type { CommandRunner, CommandRunOptions } from "../../scheduler/command-runner.js";

// The CLI's own exit code is the real liveness signal (execFile rejects on
// non-zero exit) — succeedsWithReply models a real "OK" completion, throws
// models a real auth failure (non-zero exit), matching how a real
// `claude -p ... --max-turns 1` call actually behaves for a valid vs.
// invalid token (verified live — see design-discussion.md's correction note).
function fakeCommandRunner(succeeds: boolean): CommandRunner {
  return {
    run: async (command: string, args: string[], options?: CommandRunOptions) => {
      assert.equal(command, "claude");
      assert.deepEqual(args, ["-p", "reply with the single word OK", "--max-turns", "1"]);
      assert.ok(options?.env?.CLAUDE_CODE_OAUTH_TOKEN, "must set CLAUDE_CODE_OAUTH_TOKEN for this call");
      if (!succeeds) {
        throw new Error("Failed to authenticate. API Error: 401 OAuth access token is invalid.");
      }
      return { stdout: "OK", stderr: "" };
    },
  };
}

function fakeFetch(status: number, headers: Record<string, string> = {}, body?: unknown): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    // Sanity: probe must send the auth header, never omit it.
    const h = init?.headers as Record<string, string> | undefined;
    assert.ok(h?.["x-api-key"], "probe must send x-api-key");
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name] ?? null },
      json: async () => {
        if (body === undefined) throw new Error("no body configured on this fake response");
        return body;
      },
    } as unknown as Response;
  }) as typeof fetch;
}

test("a successful probe resolves to up", async () => {
  const result = await probeClaudeLane("sk-ant-fake", fakeFetch(200));
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null });
});

test("402 resolves to out_of_credit", async () => {
  const result = await probeClaudeLane("sk-ant-fake", fakeFetch(402));
  assert.equal(result.status, "out_of_credit");
});

test("429 resolves to degraded and carries the reset header as reset_at", async () => {
  const result = await probeClaudeLane(
    "sk-ant-fake",
    fakeFetch(429, { "anthropic-ratelimit-requests-reset": "2026-07-25T12:05:00.000Z" }),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.reset_at, "2026-07-25T12:05:00.000Z");
});

test("hdl-429-corroboration: a 429 with no parseable body falls back to parseClaudeCapSignal's own generic reason, never crashes", async () => {
  const result = await probeClaudeLane("sk-ant-fake", fakeFetch(429));
  assert.equal(result.status, "degraded");
  // parseClaudeCapSignal always classifies a bare 429 as "rate_limit" and
  // supplies its own fallback reason when no real message is extractable —
  // this IS the "never have less info than before" floor, just phrased by
  // the shared error-parser instead of a second hardcoded string here.
  assert.equal(result.reason, "Claude API limit reached");
});

test("hdl-429-corroboration: a 429 with a real error.message body surfaces that message as reason, not the generic string", async () => {
  const result = await probeClaudeLane(
    "sk-ant-fake",
    fakeFetch(
      429,
      { "anthropic-ratelimit-requests-reset": "2026-07-25T12:05:00.000Z" },
      { type: "error", error: { type: "rate_limit_error", message: "This request would exceed the rate limit for your organization." } },
    ),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.reason, "This request would exceed the rate limit for your organization.");
});

test("hdl-429-corroboration: a 429 whose message names a weekly limit resolves to out_of_credit, not degraded", async () => {
  const result = await probeClaudeLane(
    "sk-ant-fake",
    fakeFetch(
      429,
      {},
      { type: "error", error: { type: "rate_limit_error", message: "Your weekly limit has been reached." } },
    ),
  );
  assert.equal(result.status, "out_of_credit");
  assert.equal(result.reason, "Your weekly limit has been reached.");
});

test("hdl-429-corroboration: reset_at prefers the specific anthropic-ratelimit-requests-reset header over retry-after", async () => {
  const result = await probeClaudeLane(
    "sk-ant-fake",
    fakeFetch(
      429,
      { "anthropic-ratelimit-requests-reset": "2026-07-25T12:05:00.000Z", "retry-after": "30" },
      { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
    ),
  );
  assert.equal(result.reset_at, "2026-07-25T12:05:00.000Z");
});

test("hdl-429-corroboration: reset_at falls back to retry-after when the specific header is absent", async () => {
  const result = await probeClaudeLane(
    "sk-ant-fake",
    fakeFetch(429, { "retry-after": "30" }, { type: "error", error: { type: "rate_limit_error", message: "rate limited" } }),
  );
  // Not asserting the exact instant (parseClaudeCapSignal uses its own now()) — just that a real timestamp came through, not null.
  assert.ok(result.reset_at !== null && !Number.isNaN(Date.parse(result.reset_at)), `expected a real timestamp, got ${result.reset_at}`);
});

test("401/403 resolves to down (auth failure)", async () => {
  const result401 = await probeClaudeLane("bad-key", fakeFetch(401));
  assert.equal(result401.status, "down");
  const result403 = await probeClaudeLane("bad-key", fakeFetch(403));
  assert.equal(result403.status, "down");
});

test("5xx resolves to down (server error)", async () => {
  const result = await probeClaudeLane("sk-ant-fake", fakeFetch(503));
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /503/);
});

test("a network-level failure resolves to down rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await probeClaudeLane("sk-ant-fake", fetchImpl);
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /ECONNREFUSED/);
});

test("uses the lightweight models-list endpoint, not a completion call", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = url;
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
  }) as typeof fetch;
  await probeClaudeLane("sk-ant-fake", fetchImpl);
  assert.equal(calledUrl, "https://api.anthropic.com/v1/models");
});

test("hdl-csl-02: a credential starting with sk-ant-oat01- dispatches to the CLI-based subscription check, never HTTP", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("must not call fetch for a subscription-token credential");
  }) as typeof fetch;
  const result = await probeClaudeLane(
    "sk-ant-oat01-fake-subscription-token",
    fetchImpl,
    fakeCommandRunner(true),
  );
  assert.equal(result.status, "up");
});

test("hdl-csl-02: probeClaudeSubscriptionLane resolves a successful completion (exit 0) to up", async () => {
  const result = await probeClaudeSubscriptionLane("sk-ant-oat01-fake", fakeCommandRunner(true));
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null });
});

test("hdl-csl-02: probeClaudeSubscriptionLane never throws on a CommandRunner exec failure (invalid token / non-zero exit) — resolves to down", async () => {
  const result = await probeClaudeSubscriptionLane("sk-ant-oat01-fake", fakeCommandRunner(false));
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /claude CLI auth check failed/);
  assert.match(result.reason ?? "", /401/);
});
