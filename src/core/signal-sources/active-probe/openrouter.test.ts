import { test } from "node:test";
import assert from "node:assert/strict";
import { probeOpenRouterLane } from "./openrouter.js";

function fakeFetch(
  status: number,
  body: unknown = null,
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

test("a 2xx response with positive limit_remaining resolves to up", async () => {
  const result = await probeOpenRouterLane(
    "fake-key",
    fakeFetch(200, { data: { limit: 100, limit_remaining: 42 } }),
  );
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null, error_code: null });
});

test("a 2xx response with null limit_remaining (unlimited) resolves to up", async () => {
  const result = await probeOpenRouterLane(
    "fake-key",
    fakeFetch(200, { data: { limit: null, limit_remaining: null } }),
  );
  assert.equal(result.status, "up");
});

test("a 2xx response with limit_remaining <= 0 resolves to out_of_credit despite HTTP 200", async () => {
  const result = await probeOpenRouterLane(
    "fake-key",
    fakeFetch(200, { data: { limit: 100, limit_remaining: 0 } }),
  );
  assert.equal(result.status, "out_of_credit");
});

test("an explicit 402 resolves to out_of_credit regardless of body shape", async () => {
  const result = await probeOpenRouterLane("fake-key", fakeFetch(402, {}));
  assert.equal(result.status, "out_of_credit");
});

test("401/403 resolves to down (auth failure)", async () => {
  const result401 = await probeOpenRouterLane("bad-key", fakeFetch(401));
  assert.equal(result401.status, "down");
  const result403 = await probeOpenRouterLane("bad-key", fakeFetch(403));
  assert.equal(result403.status, "down");
});

test("hdl-error-taxonomy: 429 resolves to degraded/rate_limit and surfaces the real error.message, never guesses at X-RateLimit-Reset's undocumented format", async () => {
  const result = await probeOpenRouterLane(
    "fake-key",
    fakeFetch(
      429,
      { error: { code: 429, message: "Rate limit exceeded", metadata: { error_type: "rate_limit_exceeded" } } },
      { "x-ratelimit-reset": "1755000000" },
    ),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.error_code, "rate_limit");
  assert.equal(result.reason, "Rate limit exceeded");
  // reset_at intentionally stays null — OpenRouter's own docs don't specify
  // this header's format (confirmed via research), so a raw passthrough
  // would be a confidently-wrong guess, not an honest reading.
  assert.equal(result.reset_at, null);
});

test("429 with no reset header present resolves to degraded with null reset_at", async () => {
  const result = await probeOpenRouterLane("fake-key", fakeFetch(429));
  assert.equal(result.status, "degraded");
  assert.equal(result.reset_at, null);
});

test("5xx resolves to down (server error)", async () => {
  const result = await probeOpenRouterLane("fake-key", fakeFetch(503));
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /503/);
});

test("a malformed 2xx body defaults to up rather than guessing a credit state", async () => {
  const fetchImpl: typeof fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("not json");
    },
    headers: { get: () => null },
  })) as unknown as typeof fetch;
  const result = await probeOpenRouterLane("fake-key", fetchImpl);
  assert.equal(result.status, "up");
});

test("a network-level failure resolves to down rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await probeOpenRouterLane("fake-key", fetchImpl);
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /ECONNREFUSED/);
});

test("uses the account key-introspection endpoint with Bearer auth", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = url;
    const h = init?.headers as Record<string, string> | undefined;
    assert.equal(h?.authorization, "Bearer fake-key");
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { limit_remaining: 10 } }),
      headers: { get: () => null },
    } as unknown as Response;
  }) as typeof fetch;
  await probeOpenRouterLane("fake-key", fetchImpl);
  assert.equal(calledUrl, "https://openrouter.ai/api/v1/key");
});
