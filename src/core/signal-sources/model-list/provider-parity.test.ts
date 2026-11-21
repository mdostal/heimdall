import { test } from "node:test";
import assert from "node:assert/strict";
import { listOpenRouterModels } from "./openrouter.js";
import { listGrokModels } from "./grok.js";

for (const [name, list, url] of [
  ["openrouter", listOpenRouterModels, "https://openrouter.ai/api/v1/models"],
  ["grok", listGrokModels, "https://api.x.ai/v1/models"],
] as const) {
  test(name + ": authenticates and tolerates malformed rows and dates", async () => {
    const fetchImpl = (async (input, init) => {
      assert.equal(input, url);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret");
      return new Response(JSON.stringify({ data: [
        null, {}, { id: 4 }, { id: "" },
        { id: "good", created: 1700000000 },
        { id: "no-date" }, { id: "bad-date", created: 1e30 },
      ] }));
    }) as typeof fetch;
    assert.deepEqual(await list("secret", fetchImpl), [
      { id: "good", createdAt: "2023-11-14T22:13:20.000Z" },
      { id: "no-date", createdAt: null },
      { id: "bad-date", createdAt: null },
    ]);
  });
  test(name + ": isolates network, HTTP, JSON and schema errors", async () => {
    for (const fetchImpl of [
      async () => { throw new Error("offline"); },
      async () => new Response("{}", { status: 401 }),
      async () => new Response("bad-json"),
      async () => new Response("null"),
      async () => new Response('{"data":{}}'),
    ]) assert.deepEqual(await list("secret", fetchImpl as typeof fetch), []);
  });
}
