import { test } from "node:test";
import assert from "node:assert/strict";
import { probeClaudeLane } from "./claude.js";

function fakeFetch(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    // Sanity: probe must send the auth header, never omit it.
    const h = init?.headers as Record<string, string> | undefined;
    assert.ok(h?.["x-api-key"], "probe must send x-api-key");
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name] ?? null },
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
