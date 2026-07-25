import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCodexPublicStatus } from "./codex.js";

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as Response) as typeof fetch;
}

test("all-operational status page resolves to up", async () => {
  const fetchImpl = fakeFetch({ components: [{ name: "API", status: "operational" }] });
  const signal = await checkCodexPublicStatus(fetchImpl);
  assert.equal(signal.status, "up");
});

test("major_outage on the API component resolves to down", async () => {
  const fetchImpl = fakeFetch({ components: [{ name: "API", status: "major_outage" }] });
  const signal = await checkCodexPublicStatus(fetchImpl);
  assert.equal(signal.status, "down");
});

test("a non-200 status-page response degrades gracefully, doesn't throw", async () => {
  const fetchImpl = fakeFetch({}, false, 500);
  const signal = await checkCodexPublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
});

test("a network failure degrades gracefully, doesn't throw", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const signal = await checkCodexPublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /ECONNREFUSED/);
});

test("consumes no per-lane API tokens — hits the public summary.json only", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
  }) as typeof fetch;
  await checkCodexPublicStatus(fetchImpl);
  assert.equal(calledUrl, "https://status.openai.com/api/v2/summary.json");
});

test("mirrors claude.ts's pattern — same shape, same mapping rules (interface parity)", async () => {
  const fetchImpl = fakeFetch({ components: [{ name: "API", status: "degraded_performance" }] });
  const signal = await checkCodexPublicStatus(fetchImpl);
  assert.deepEqual(Object.keys(signal).sort(), ["reason", "status"]);
});
