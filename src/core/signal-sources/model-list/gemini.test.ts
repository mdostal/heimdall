import { test } from "node:test";
import assert from "node:assert/strict";
import { listGeminiModels } from "./gemini.js";

function fakeFetch(status: number, body: unknown = null): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const h = init?.headers as Record<string, string> | undefined;
    assert.ok(h?.["x-goog-api-key"], "must send x-goog-api-key");
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

test("returns id (stripped of the models/ prefix) with createdAt always null", async () => {
  const result = await listGeminiModels(
    "fake-key",
    fakeFetch(200, {
      models: [
        { name: "models/gemini-3-pro-preview", displayName: "Gemini 3 Pro Preview" },
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      ],
    }),
  );
  assert.deepEqual(result, [
    { id: "gemini-3-pro-preview", createdAt: null },
    { id: "gemini-2.5-pro", createdAt: null },
  ]);
});

test("uses the exact same URL as active-probe/gemini.ts", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ models: [] }) } as unknown as Response;
  }) as typeof fetch;
  await listGeminiModels("fake-key", fetchImpl);
  assert.equal(calledUrl, "https://generativelanguage.googleapis.com/v1beta/models");
});

test("a non-2xx response returns []", async () => {
  const result = await listGeminiModels("bad-key", fakeFetch(403));
  assert.deepEqual(result, []);
});

test("a malformed body (no models array) returns []", async () => {
  const result = await listGeminiModels("fake-key", fakeFetch(200, { unexpected: "shape" }));
  assert.deepEqual(result, []);
});

test("a network-level failure returns [] rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await listGeminiModels("fake-key", fetchImpl);
  assert.deepEqual(result, []);
});
