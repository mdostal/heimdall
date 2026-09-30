import { test } from "node:test";
import assert from "node:assert/strict";
import { probeGrokLane } from "./grok.js";

function fakeFetch(status: number, body: unknown = null, headers: Record<string, string> = {}): typeof fetch {
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
  const result = await probeGrokLane("fake-key", fakeFetch(200));
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null, error_code: null });
});

test("401 resolves to down with auth_failed", async () => {
  const result = await probeGrokLane(
    "bad-key",
    fakeFetch(401, { error: { code: "invalid_api_key", message: "Invalid API key" } }),
  );
  assert.equal(result.status, "down");
  assert.equal(result.error_code, "auth_failed");
  assert.equal(result.reason, "Invalid API key");
});

test("401 with malformed body still resolves to down with auth_failed", async () => {
  const fetchImpl: typeof fetch = (async () => ({
    ok: false,
    status: 401,
    json: async () => {
      throw new Error("not json");
    },
    headers: { get: () => null },
  })) as unknown as typeof fetch;
  const result = await probeGrokLane("bad-key", fetchImpl);
  assert.equal(result.status, "down");
  assert.equal(result.error_code, "auth_failed");
  assert.match(result.reason ?? "", /401/);
});

test("402 resolves to out_of_credit with billing_error", async () => {
  const result = await probeGrokLane(
    "fake-key",
    fakeFetch(402, { error: { code: "insufficient_quota", message: "You have exceeded your quota" } }),
  );
  assert.equal(result.status, "out_of_credit");
  assert.equal(result.error_code, "billing_error");
  assert.equal(result.reason, "You have exceeded your quota");
});

test("402 with no body resolves to out_of_credit", async () => {
  const result = await probeGrokLane("fake-key", fakeFetch(402));
  assert.equal(result.status, "out_of_credit");
  assert.equal(result.error_code, "billing_error");
});

test("429 resolves to degraded with rate_limit, reset_at converted to an absolute timestamp", async () => {
  const result = await probeGrokLane(
    "fake-key",
    fakeFetch(
      429,
      { error: { code: "rate_limit_exceeded", message: "Rate limit exceeded" } },
      { "retry-after": "60" },
    ),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.error_code, "rate_limit");
  assert.equal(result.reason, "Rate limit exceeded");
  assert.ok(result.reset_at !== null && !Number.isNaN(Date.parse(result.reset_at)), `expected a real timestamp, got ${result.reset_at}`);
  const deltaMs = Date.parse(result.reset_at!) - Date.now();
  assert.ok(deltaMs > 55_000 && deltaMs < 65_000, `expected ~60s out, got ${deltaMs}ms`);
});

test("429 with no retry-after header resolves to degraded with null reset_at", async () => {
  const result = await probeGrokLane("fake-key", fakeFetch(429));
  assert.equal(result.status, "degraded");
  assert.equal(result.error_code, "rate_limit");
  assert.equal(result.reset_at, null);
});

test("429 with malformed body defaults to degraded with generic reason", async () => {
  const fetchImpl: typeof fetch = (async () => ({
    ok: false,
    status: 429,
    json: async () => {
      throw new Error("not json");
    },
    headers: { get: () => null },
  })) as unknown as typeof fetch;
  const result = await probeGrokLane("fake-key", fetchImpl);
  assert.equal(result.status, "degraded");
  assert.equal(result.error_code, "rate_limit");
});

test("403 resolves to down with auth_failed", async () => {
  const result = await probeGrokLane(
    "bad-key",
    fakeFetch(403, { error: { message: "Forbidden" } }),
  );
  assert.equal(result.status, "down");
  assert.equal(result.error_code, "auth_failed");
});

test("5xx resolves to down (server error)", async () => {
  const result = await probeGrokLane("fake-key", fakeFetch(503));
  assert.equal(result.status, "down");
  assert.equal(result.error_code, "server_error");
  assert.match(result.reason ?? "", /503/);
});

test("a network-level failure resolves to down rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await probeGrokLane("fake-key", fetchImpl);
  assert.equal(result.status, "down");
  assert.equal(result.error_code, "network_error");
  assert.match(result.reason ?? "", /ECONNREFUSED/);
});

test("an unexpected non-error status resolves to degraded", async () => {
  const result = await probeGrokLane("fake-key", fakeFetch(418));
  assert.equal(result.status, "degraded");
  assert.equal(result.error_code, "unknown");
  assert.match(result.reason ?? "", /418/);
});

test("uses the models endpoint with Bearer auth", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = url;
    const h = init?.headers as Record<string, string> | undefined;
    assert.equal(h?.authorization, "Bearer fake-key");
    return { ok: true, status: 200, json: async () => null, headers: { get: () => null } } as unknown as Response;
  }) as typeof fetch;
  await probeGrokLane("fake-key", fetchImpl);
  assert.equal(calledUrl, "https://api.x.ai/v1/models");
});
