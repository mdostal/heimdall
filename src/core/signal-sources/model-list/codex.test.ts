import { test } from "node:test";
import assert from "node:assert/strict";
import { listCodexModels } from "./codex.js";

function fakeFetch(status: number, body: unknown = null): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const h = init?.headers as Record<string, string> | undefined;
    assert.equal(h?.authorization, "Bearer sk-fake");
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

test("returns id + createdAt (converted from a Unix timestamp) per entry", async () => {
  const result = await listCodexModels(
    "sk-fake",
    fakeFetch(200, { data: [{ id: "gpt-codex", object: "model", created: 1770000000, owned_by: "openai" }] }),
  );
  assert.deepEqual(result, [{ id: "gpt-codex", createdAt: new Date(1770000000 * 1000).toISOString() }]);
});

test("uses the exact same URL as active-probe/codex.ts", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
  }) as typeof fetch;
  await listCodexModels("sk-fake", fetchImpl);
  assert.equal(calledUrl, "https://api.openai.com/v1/models");
});

test("an entry with no created field resolves createdAt to null", async () => {
  const result = await listCodexModels("sk-fake", fakeFetch(200, { data: [{ id: "some-model" }] }));
  assert.deepEqual(result, [{ id: "some-model", createdAt: null }]);
});

test("a non-2xx response returns []", async () => {
  const result = await listCodexModels("bad-key", fakeFetch(401));
  assert.deepEqual(result, []);
});

test("a network-level failure returns [] rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await listCodexModels("sk-fake", fetchImpl);
  assert.deepEqual(result, []);
});
