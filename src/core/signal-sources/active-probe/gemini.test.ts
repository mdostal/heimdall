import { test } from "node:test";
import assert from "node:assert/strict";
import { probeGeminiLane } from "./gemini.js";

function fakeFetch(status: number, body: unknown = null): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    // Sanity: probe must send the auth header, never the ?key= query param.
    const h = init?.headers as Record<string, string> | undefined;
    assert.ok(h?.["x-goog-api-key"], "probe must send x-goog-api-key header");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

test("a successful probe resolves to up", async () => {
  const result = await probeGeminiLane("fake-key", fakeFetch(200));
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null });
});

test("401/403 resolves to down (auth failure)", async () => {
  const result401 = await probeGeminiLane("bad-key", fakeFetch(401));
  assert.equal(result401.status, "down");
  const result403 = await probeGeminiLane("bad-key", fakeFetch(403));
  assert.equal(result403.status, "down");
});

test("429 with a quota-flavored body resolves to out_of_credit, reset_at always null", async () => {
  const result = await probeGeminiLane(
    "fake-key",
    fakeFetch(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Daily quota exceeded" } }),
  );
  assert.equal(result.status, "out_of_credit");
  assert.equal(result.reset_at, null);
});

test("429 with a plain rate-limit body resolves to degraded, reset_at always null", async () => {
  const result = await probeGeminiLane(
    "fake-key",
    fakeFetch(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many requests per minute" } }),
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.reset_at, null);
});

test("429 with an unparseable body defaults to degraded, never guesses out_of_credit", async () => {
  const fetchImpl: typeof fetch = (async () => ({
    ok: false,
    status: 429,
    json: async () => {
      throw new Error("not json");
    },
  })) as unknown as typeof fetch;
  const result = await probeGeminiLane("fake-key", fetchImpl);
  assert.equal(result.status, "degraded");
  assert.equal(result.reset_at, null);
});

test("5xx resolves to down (server error)", async () => {
  const result = await probeGeminiLane("fake-key", fakeFetch(503));
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /503/);
});

test("a network-level failure resolves to down rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await probeGeminiLane("fake-key", fetchImpl);
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /ECONNREFUSED/);
});

test("uses the lightweight models-list endpoint with the header, not the ?key= query param", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = url;
    const h = init?.headers as Record<string, string> | undefined;
    assert.ok(h?.["x-goog-api-key"], "must use header auth");
    return { ok: true, status: 200, json: async () => null } as unknown as Response;
  }) as typeof fetch;
  await probeGeminiLane("fake-key", fetchImpl);
  assert.equal(calledUrl, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.doesNotMatch(String(calledUrl), /key=/, "API key must never appear in the URL");
});
