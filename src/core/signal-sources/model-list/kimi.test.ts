import { test } from "node:test";
import assert from "node:assert/strict";
import { listKimiModels } from "./kimi.js";

function fakeFetch(status: number, body: unknown = null): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const h = init?.headers as Record<string, string> | undefined;
    assert.equal(h?.authorization, "Bearer fake-key");
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

test("returns id + createdAt when the response includes a created field", async () => {
  const result = await listKimiModels("fake-key", fakeFetch(200, { data: [{ id: "moonshotai/kimi-k3", created: 1770000000 }] }));
  assert.deepEqual(result, [{ id: "moonshotai/kimi-k3", createdAt: new Date(1770000000 * 1000).toISOString() }]);
});

test("returns createdAt: null when the field is absent — never assumed present (unconfirmed live per research-brief.md)", async () => {
  const result = await listKimiModels("fake-key", fakeFetch(200, { data: [{ id: "moonshotai/kimi-k3" }] }));
  assert.deepEqual(result, [{ id: "moonshotai/kimi-k3", createdAt: null }]);
});

test("uses the exact same URL as active-probe/kimi.ts", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
  }) as typeof fetch;
  await listKimiModels("fake-key", fetchImpl);
  assert.equal(calledUrl, "https://api.moonshot.ai/v1/models");
});

test("a non-2xx response returns []", async () => {
  const result = await listKimiModels("bad-key", fakeFetch(401));
  assert.deepEqual(result, []);
});

test("a network-level failure returns [] rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await listKimiModels("fake-key", fetchImpl);
  assert.deepEqual(result, []);
});
