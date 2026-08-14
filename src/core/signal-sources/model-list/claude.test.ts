import { test } from "node:test";
import assert from "node:assert/strict";
import { listClaudeModels } from "./claude.js";

function fakeFetch(status: number, body: unknown = null): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const h = init?.headers as Record<string, string> | undefined;
    assert.ok(h?.["x-api-key"], "must send x-api-key");
    assert.equal(h?.["anthropic-version"], "2023-06-01");
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

test("returns id + createdAt per entry from a real-shaped response", async () => {
  const result = await listClaudeModels(
    "sk-ant-fake",
    fakeFetch(200, {
      data: [
        { id: "claude-opus-5", created_at: "2026-02-04T00:00:00Z", display_name: "Claude Opus 5" },
        { id: "claude-sonnet-4-5", created_at: "2025-09-01T00:00:00Z" },
      ],
    }),
  );
  assert.deepEqual(result, [
    { id: "claude-opus-5", createdAt: "2026-02-04T00:00:00Z" },
    { id: "claude-sonnet-4-5", createdAt: "2025-09-01T00:00:00Z" },
  ]);
});

test("uses the exact same URL as active-probe/claude.ts", async () => {
  let calledUrl: unknown;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
  }) as typeof fetch;
  await listClaudeModels("sk-ant-fake", fetchImpl);
  assert.equal(calledUrl, "https://api.anthropic.com/v1/models");
});

test("a non-2xx response returns [] rather than throwing", async () => {
  const result = await listClaudeModels("bad-key", fakeFetch(401));
  assert.deepEqual(result, []);
});

test("a malformed body (no data array) returns []", async () => {
  const result = await listClaudeModels("sk-ant-fake", fakeFetch(200, { unexpected: "shape" }));
  assert.deepEqual(result, []);
});

test("a network-level failure returns [] rather than throwing", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await listClaudeModels("sk-ant-fake", fetchImpl);
  assert.deepEqual(result, []);
});
