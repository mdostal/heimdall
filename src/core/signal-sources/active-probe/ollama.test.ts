import { test } from "node:test";
import assert from "node:assert/strict";
import { probeOllamaLane } from "./ollama.js";

function fakeFetch(status: number, body: unknown = { models: [] }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const h = init?.headers as Record<string, string> | undefined;
    assert.equal(h, undefined, "Ollama's local API must never send an auth header");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

test("a 2xx response with parseable JSON resolves to up", async () => {
  const result = await probeOllamaLane("http://localhost:11434", fakeFetch(200));
  assert.deepEqual(result, { status: "up", reset_at: null, reason: null, error_code: null });
});

test("a non-2xx response resolves to down", async () => {
  const result = await probeOllamaLane("http://localhost:11434", fakeFetch(500));
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /500/);
});

test("a 2xx response with unparseable JSON resolves to down, never guesses up", async () => {
  const fetchImpl: typeof fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("not json");
    },
  })) as unknown as typeof fetch;
  const result = await probeOllamaLane("http://localhost:11434", fetchImpl);
  assert.equal(result.status, "down");
});

test("a network-level failure (connection refused) resolves to down rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await probeOllamaLane("http://localhost:11434", fetchImpl);
  assert.equal(result.status, "down");
  assert.match(result.reason ?? "", /ECONNREFUSED/);
});

test("an http:// credential value is used directly as the base URL", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  await probeOllamaLane("http://gpu-box.local:11434", fetchImpl);
  assert.equal(calledUrl, "http://gpu-box.local:11434/api/tags");
});

test("an https:// credential value is used directly as the base URL", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  await probeOllamaLane("https://ollama.internal", fetchImpl);
  assert.equal(calledUrl, "https://ollama.internal/api/tags");
});

test("a non-URL-shaped credential value defaults to http://localhost:11434", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  await probeOllamaLane("some-placeholder-value", fetchImpl);
  assert.equal(calledUrl, "http://localhost:11434/api/tags");
});

test("an empty credential value defaults to http://localhost:11434", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  await probeOllamaLane("", fetchImpl);
  assert.equal(calledUrl, "http://localhost:11434/api/tags");
});
