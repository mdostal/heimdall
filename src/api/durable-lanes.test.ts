import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { StateStore } from "../core/state-store.js";
import { loadLaneDeclarations } from "../core/lane-registry.js";
import { addLane, buildLaneRegistry, createHttpServer, getLaneStatuses } from "./http-server.js";

test("API lanes survive a recreated service with credentials, model and duplicate protection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-lanes-"));
  const path = join(dir, "state.db");
  let store = new StateStore(path);
  const registry = buildLaneRegistry({}, store);
  const server = createHttpServer(registry, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const url = `http://localhost:${(server.address() as AddressInfo).port}/lanes`;
    const input = { lane_id: "sixth", provider: "gemini", model: "gemini-pro", token: "private-token" };
    const response = await fetch(url, { method: "POST", body: JSON.stringify(input) });
    assert.equal(response.status, 201);
    assert.doesNotMatch(await response.text(), /private-token/);
    assert.equal((await fetch(url, { method: "POST", body: JSON.stringify(input) })).status, 409);
    store.close();
    store = new StateStore(path);
    const rebuilt = buildLaneRegistry({}, store);
    assert.equal(rebuilt.get("sixth")?.credential, input.token);
    assert.equal(rebuilt.get("sixth")?.model, input.model);
    assert.doesNotMatch(JSON.stringify(getLaneStatuses(rebuilt, store)), /private-token/);
    assert.equal(addLane(rebuilt, store, input).ok, false);
    const overridden = buildLaneRegistry({
      HEIMDALL_LANE_1_ID: "sixth", HEIMDALL_LANE_1_PROVIDER: "claude",
      HEIMDALL_LANE_1_CREDENTIAL_REF: "ENV_TOKEN", ENV_TOKEN: "env-secret",
    }, store);
    assert.equal(overridden.list().length, 1);
    assert.equal(overridden.get("sixth")?.provider, "claude");
    assert.equal(overridden.get("sixth")?.credential, "env-secret");
    assert.equal(buildLaneRegistry({}, store).get("sixth")?.credential, input.token);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JSON config accepts more than five lanes and overrides numbered declarations", () => {
  const lanes = Array.from({ length: 12 }, (_, i) => ({ lane_id: `lane-${i}`, provider: "gemini", credential_ref: `TOKEN_${i}` }));
  const declarations = loadLaneDeclarations({
    HEIMDALL_LANES_JSON: JSON.stringify(lanes),
    HEIMDALL_LANE_1_ID: "lane-0", HEIMDALL_LANE_1_PROVIDER: "old",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "OLD_TOKEN",
  });
  assert.equal(declarations.length, 12);
  assert.equal(declarations[0].provider, "gemini");
  for (const value of ["{}", "broken", '[{"lane_id":"bad"}]']) {
    assert.throws(() => loadLaneDeclarations({ HEIMDALL_LANES_JSON: value }));
  }
});

test("API IDs that normalize to the same env name retain distinct credentials", () => {
  const store = new StateStore();
  try {
    const registry = buildLaneRegistry({}, store);
    for (const lane_id of ["a-b", "a@b"]) {
      assert.equal(addLane(registry, store, { lane_id, provider: "gemini", model: "pro", token: lane_id }).ok, true);
    }
    const rebuilt = buildLaneRegistry({}, store);
    assert.equal(rebuilt.get("a-b")?.credential, "a-b");
    assert.equal(rebuilt.get("a@b")?.credential, "a@b");
  } finally {
    store.close();
  }
});

test("a failed DB write never acknowledges creation", () => {
  const store = new StateStore();
  const registry = buildLaneRegistry({}, store);
  store.close();
  assert.throws(() => addLane(registry, store, { lane_id: "new", provider: "gemini", model: "pro", token: "secret" }));
  assert.equal(registry.get("new"), null);
});

test("opening an existing state DB adds declaration storage without reviving status-only lanes", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "heimdall-legacy-"));
  const path = join(dir, "state.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE lanes (lane_id TEXT PRIMARY KEY, provider TEXT NOT NULL, credential_ref TEXT NOT NULL);
    INSERT INTO lanes VALUES ('old-env-lane', 'gemini', 'OLD_TOKEN');`);
  legacy.close();
  const store = new StateStore(path);
  try {
    assert.equal(buildLaneRegistry({}, store).list().length, 0);
    store.setManualOverride("old-env-lane", "disabled");
    assert.equal(addLane(buildLaneRegistry({}, store), store, {
      lane_id: "new", provider: "gemini", model: "pro", token: "secret",
    }).ok, true);
    assert.equal(buildLaneRegistry({}, store).get("new")?.credential, "secret");
    assert.equal(store.getManualOverride("old-env-lane"), "disabled");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
