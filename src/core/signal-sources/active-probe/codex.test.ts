import { test } from "node:test";
import assert from "node:assert/strict";
import { probeCodexLane } from "./codex.js";

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
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null });
});

test("401/403 resolves to down (auth failure)", async () => {
  const result401 = await probeCodexLane("bad-key", fakeFetch(401));
  assert.equal(result401.status, "down");
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
});

test("429 without a quota-specific code resolves to degraded (plain rate limit)", async () => {
  const result = await probeCodexLane(
    "sk-fake",
    fakeFetch(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "30" }),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.reset_at, "30");
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
