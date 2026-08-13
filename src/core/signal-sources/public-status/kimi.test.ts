import { test } from "node:test";
import assert from "node:assert/strict";
import { checkKimiPublicStatus } from "./kimi.js";

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
      { name: "API Service", status: "operational" },
      { name: "Text Model", status: "operational" },
    ],
  });
  const signal = await checkKimiPublicStatus(fetchImpl);
  assert.equal(signal.status, "up");
  assert.equal(signal.reason, null);
});

test("degraded_performance on a matching component resolves to degraded", async () => {
  const fetchImpl = fakeFetch({
    components: [{ name: "Open API", status: "degraded_performance" }],
  });
  const signal = await checkKimiPublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /Open API/);
});

test("major_outage on a matching component resolves to down", async () => {
  const fetchImpl = fakeFetch({
    components: [{ name: "Thinking Model", status: "major_outage" }],
  });
  const signal = await checkKimiPublicStatus(fetchImpl);
  assert.equal(signal.status, "down");
});

test("an incident on an unrelated component does not flag this lane", async () => {
  const fetchImpl = fakeFetch({
    components: [{ name: "Sign In / Sign Up", status: "major_outage" }],
  });
  const signal = await checkKimiPublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.equal(signal.reason, "no matching status-page component found");
});

test("a non-200 status-page response degrades gracefully, doesn't throw", async () => {
  const signal = await checkKimiPublicStatus(fakeFetch({}, false, 500));
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /500/);
});

test("a network failure degrades gracefully, doesn't throw", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const signal = await checkKimiPublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /ECONNREFUSED/);
});

test("consumes no per-lane API tokens — only calls the public status endpoint", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    callCount += 1;
    assert.equal(url, "https://status.moonshot.cn/api/v2/summary.json");
    return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
  }) as typeof fetch;
  await checkKimiPublicStatus(fetchImpl);
  assert.equal(callCount, 1);
});
