import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaudePublicStatus } from "./claude.js";

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as Response) as typeof fetch;
}

test("all-operational status page resolves to up", async () => {
  const fetchImpl = fakeFetch({
    components: [
      { name: "Claude Code", status: "operational" },
      { name: "api.anthropic.com", status: "operational" },
    ],
  });
  const signal = await checkClaudePublicStatus(fetchImpl);
  assert.equal(signal.status, "up");
  assert.equal(signal.reason, null);
});

test("degraded_performance on the API component resolves to degraded", async () => {
  const fetchImpl = fakeFetch({
    components: [
      { name: "Claude Code", status: "operational" },
      { name: "api.anthropic.com", status: "degraded_performance" },
    ],
  });
  const signal = await checkClaudePublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /api\.anthropic\.com/);
});

test("major_outage resolves to down", async () => {
  const fetchImpl = fakeFetch({
    components: [{ name: "Claude Code", status: "major_outage" }],
  });
  const signal = await checkClaudePublicStatus(fetchImpl);
  assert.equal(signal.status, "down");
});

test("an unrelated component incident (claude.ai only) does not flag this lane", async () => {
  const fetchImpl = fakeFetch({
    components: [{ name: "claude.ai", status: "major_outage" }],
  });
  const signal = await checkClaudePublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.equal(signal.reason, "no matching status-page component found");
});

test("a non-200 status-page response degrades gracefully, doesn't throw", async () => {
  const fetchImpl = fakeFetch({}, false, 500);
  const signal = await checkClaudePublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /500/);
});

test("a network failure degrades gracefully, doesn't throw", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const signal = await checkClaudePublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /ECONNREFUSED/);
});

test("consumes no per-lane API tokens — only calls the public fetch, no credential involved", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    callCount += 1;
    assert.equal(url, "https://status.claude.com/api/v2/summary.json");
    return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
  }) as typeof fetch;
  await checkClaudePublicStatus(fetchImpl);
  assert.equal(callCount, 1);
});
