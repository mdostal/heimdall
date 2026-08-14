import { test } from "node:test";
import assert from "node:assert/strict";
import { probeKimiLane } from "./kimi.js";

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
  const result = await probeKimiLane("fake-key", fakeFetch(200));
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null });
});

test("401 with invalid_api_key resolves to down", async () => {
  const result = await probeKimiLane(
    "bad-key",
    fakeFetch(401, { error: { type: "invalid_api_key", message: "The API Key appears to be invalid" } }),
  );
  assert.equal(result.status, "down");
});

test("429 with engine_overloaded resolves to degraded and carries raw retry-after as reset_at", async () => {
  const result = await probeKimiLane(
    "fake-key",
    fakeFetch(429, { error: { type: "engine_overloaded", message: "try again later" } }, { "retry-after": "30" }),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.reset_at, "30");
});

test("429 with too_many_requests resolves to degraded", async () => {
  const result = await probeKimiLane(
    "fake-key",
    fakeFetch(429, { error: { type: "too_many_requests", message: "slow down" } }),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.reset_at, null);
});

test("429 with rolling_quota_exceeded resolves to out_of_credit", async () => {
  const result = await probeKimiLane(
    "fake-key",
    fakeFetch(429, { error: { type: "rolling_quota_exceeded", message: "usage limit for this period" } }),
  );
  assert.equal(result.status, "out_of_credit");
});

test("403 with billing_quota_exhausted resolves to out_of_credit", async () => {
  const result = await probeKimiLane(
    "fake-key",
    fakeFetch(403, { error: { type: "billing_quota_exhausted", message: "weekly usage limit" } }),
  );
  assert.equal(result.status, "out_of_credit");
});

test("403/429 with an unrecognized error.type defaults to degraded, never out_of_credit", async () => {
  const result = await probeKimiLane(
    "fake-key",
    fakeFetch(429, { error: { type: "some_new_error_type", message: "unknown" } }),
  );
  assert.equal(result.status, "degraded");
});

test("403/429 with a malformed body defaults to degraded", async () => {
  const fetchImpl: typeof fetch = (async () => ({
    ok: false,
    status: 429,
    json: async () => {
      throw new Error("not json");
    },
    headers: { get: () => null },
  })) as unknown as typeof fetch;
  const result = await probeKimiLane("fake-key", fetchImpl);
  assert.equal(result.status, "degraded");
});

test("5xx resolves to down (server error)", async () => {
  const result = await probeKimiLane("fake-key", fakeFetch(503));
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /503/);
});

test("a network-level failure resolves to down rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await probeKimiLane("fake-key", fetchImpl);
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /ECONNREFUSED/);
});

test("uses the lightweight models-list endpoint with Bearer auth", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = url;
    const h = init?.headers as Record<string, string> | undefined;
    assert.equal(h?.authorization, "Bearer fake-key");
    return { ok: true, status: 200, json: async () => null, headers: { get: () => null } } as unknown as Response;
  }) as typeof fetch;
  await probeKimiLane("fake-key", fetchImpl);
  assert.equal(calledUrl, "https://api.moonshot.ai/v1/models");
});
