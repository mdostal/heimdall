import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshModelCatalog, getModelCatalog, setModelEnabled } from "./model-catalog.js";
import { LaneRegistry } from "./lane-registry.js";
import { EnvCredentialSource } from "./credential-source.js";
import { StateStore } from "./state-store.js";

function claudeModelsResponse() {
  return {
    data: [
      { id: "claude-opus-5", created_at: "2026-02-04T00:00:00Z" },
      { id: "claude-sonnet-4-5", created_at: "2025-09-01T00:00:00Z" },
    ],
  };
}

function fakeFetch(responsesByUrlSubstring: Record<string, unknown>): typeof fetch {
  return (async (url: unknown) => {
    const urlStr = String(url);
    for (const [substring, body] of Object.entries(responsesByUrlSubstring)) {
      if (urlStr.includes(substring)) {
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
}

function registryWithLane(provider: string, credentialRef: string, secretValue: string, laneId = `${provider}-lane`) {
  return new LaneRegistry(
    [{ lane_id: laneId, provider, credential_ref: credentialRef }],
    new EnvCredentialSource({ [credentialRef]: secretValue }),
  );
}

test("hdl-mc-04: refreshModelCatalog fetches a claude lane's live models and stores them", async () => {
  const store = new StateStore(":memory:");
  const registry = registryWithLane("claude", "CLAUDE_TOKEN", "sk-ant-fake");
  const fetchImpl = fakeFetch({ "api.anthropic.com": claudeModelsResponse() });

  const result = await refreshModelCatalog(store, registry, fetchImpl);
  assert.equal(result.modelsSeen, 2);
  assert.deepEqual(result.providersRefreshed, ["claude"]);

  const catalog = getModelCatalog(store, "claude");
  assert.equal(catalog.length, 2);
  store.close();
});

test("hdl-mc-04: a second refresh with an unchanged live list never changes an existing enabled value", async () => {
  const store = new StateStore(":memory:");
  const registry = registryWithLane("claude", "CLAUDE_TOKEN", "sk-ant-fake");
  const fetchImpl = fakeFetch({ "api.anthropic.com": claudeModelsResponse() });

  await refreshModelCatalog(store, registry, fetchImpl);
  const firstPass = getModelCatalog(store, "claude");

  await refreshModelCatalog(store, registry, fetchImpl);
  const secondPass = getModelCatalog(store, "claude");

  for (const entry of firstPass) {
    const matching = secondPass.find((e) => e.model_id === entry.model_id);
    assert.equal(matching?.enabled, entry.enabled, "enabled must not change across refreshes of an unchanged list");
  }
  store.close();
});

test("hdl-mc-04: an operator's explicit setModelEnabled choice survives a subsequent refresh", async () => {
  const store = new StateStore(":memory:");
  const registry = registryWithLane("claude", "CLAUDE_TOKEN", "sk-ant-fake");
  const fetchImpl = fakeFetch({ "api.anthropic.com": claudeModelsResponse() });

  await refreshModelCatalog(store, registry, fetchImpl);
  const result = setModelEnabled(store, "claude", "claude-sonnet-4-5", false);
  assert.equal(result.ok, true);

  await refreshModelCatalog(store, registry, fetchImpl);
  const catalog = getModelCatalog(store, "claude");
  const sonnet = catalog.find((e) => e.model_id === "claude-sonnet-4-5");
  assert.equal(sonnet?.enabled, false, "operator override must survive the refresh");
  store.close();
});

test("hdl-mc-04: two lanes sharing the same provider AND credential_ref fetch that provider's list only ONCE", async () => {
  const store = new StateStore(":memory:");
  let callCount = 0;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    if (String(url).includes("api.anthropic.com")) callCount += 1;
    return { ok: true, status: 200, json: async () => claudeModelsResponse() } as unknown as Response;
  }) as typeof fetch;

  const registry = new LaneRegistry(
    [
      { lane_id: "claude-a", provider: "claude", credential_ref: "CLAUDE_TOKEN" },
      { lane_id: "claude-b", provider: "claude", credential_ref: "CLAUDE_TOKEN" }, // shared credential_ref
    ],
    new EnvCredentialSource({ CLAUDE_TOKEN: "sk-ant-fake" }),
  );

  await refreshModelCatalog(store, registry, fetchImpl);
  assert.equal(callCount, 1, "the shared credential must be fetched only once, not once per lane");
  store.close();
});

test("hdl-mc-04: a lane with an unconfigured credential is skipped silently, no fetch attempted", async () => {
  const store = new StateStore(":memory:");
  let called = false;
  const fetchImpl: typeof fetch = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => claudeModelsResponse() } as unknown as Response;
  }) as typeof fetch;

  const registry = new LaneRegistry(
    [{ lane_id: "claude-unconfigured", provider: "claude", credential_ref: "MISSING_TOKEN" }],
    new EnvCredentialSource({}), // MISSING_TOKEN never set — credential resolves to null
  );

  const result = await refreshModelCatalog(store, registry, fetchImpl);
  assert.equal(called, false);
  assert.deepEqual(result.providersRefreshed, []);
  store.close();
});

test("hdl-mc-04: a lane with an ungated provider (openrouter/ollama) is skipped, confirmed no fetch attempted", async () => {
  const store = new StateStore(":memory:");
  let called = false;
  const fetchImpl: typeof fetch = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;

  const registry = registryWithLane("openrouter", "OPENROUTER_TOKEN", "fake-key");
  await refreshModelCatalog(store, registry, fetchImpl);
  assert.equal(called, false);
  store.close();
});

test("hdl-mc-04: one provider's fetch failure never aborts the rest of the refresh", async () => {
  const store = new StateStore(":memory:");
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    if (String(url).includes("api.openai.com")) {
      throw new Error("network failure for codex");
    }
    return { ok: true, status: 200, json: async () => claudeModelsResponse() } as unknown as Response;
  }) as typeof fetch;

  const registry = new LaneRegistry(
    [
      { lane_id: "codex-lane", provider: "codex", credential_ref: "CODEX_TOKEN" },
      { lane_id: "claude-lane", provider: "claude", credential_ref: "CLAUDE_TOKEN" },
    ],
    new EnvCredentialSource({ CODEX_TOKEN: "sk-fake", CLAUDE_TOKEN: "sk-ant-fake" }),
  );

  const result = await refreshModelCatalog(store, registry, fetchImpl);
  assert.ok(result.providersRefreshed.includes("claude"), "claude's refresh must still succeed despite codex's failure");
  assert.equal(getModelCatalog(store, "claude").length, 2);
  store.close();
});

test("hdl-mc-04: setModelEnabled returns {ok:false, error:'unknown_model'} for a model that's never been seen", () => {
  const store = new StateStore(":memory:");
  const result = setModelEnabled(store, "claude", "never-seen-model", true);
  assert.deepEqual(result, { ok: false, error: "unknown_model" });
  store.close();
});
