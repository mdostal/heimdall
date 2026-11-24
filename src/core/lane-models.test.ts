// heimdall#142 slice 2: per-model enable/available toggles inside a lane.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { LaneRegistry, loadLaneDeclarations, parseLaneModels } from "./lane-registry.js";
import { EnvCredentialSource } from "./credential-source.js";
import { StateStore } from "./state-store.js";
import { buildLaneModels, getLaneModels, listLaneModels, setLaneModelEnabled } from "./lane-models.js";
import { clearLaneLimit, createHttpServer, getLaneStatuses, pushLaneStatus } from "../api/http-server.js";
import { buildToolDispatch, dispatchToolCall, LANES_MODELS_LIST_TOOL_NAME, LANES_MODELS_SET_ENABLED_TOOL_NAME } from "../api/mcp-server.js";
import { renderDashboardHtml } from "../api/ui/dashboard.js";

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const LANE = "claude@ff.events";
const NOW = new Date("2026-11-15T04:31:00Z");
const FABLE_MESSAGE = "You've reached your Fable limit · resets Fri 1pm (America/Chicago). /upgrade or switch to Opus to continue.";

process.env.HEIMDALL_CLAUDE_MODEL_ALIASES = `fable=${FABLE},opus=${OPUS}`;

function registry(models = `${FABLE}=premium,${OPUS}=premium`): LaneRegistry {
  return new LaneRegistry(
    loadLaneDeclarations({
      HEIMDALL_LANE_1_ID: LANE,
      HEIMDALL_LANE_1_PROVIDER: "claude",
      HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
      HEIMDALL_LANE_1_MODEL: FABLE,
      HEIMDALL_LANE_1_MODELS: models,
    }),
    new EnvCredentialSource({ CLAUDE_TOKEN: "secret" }),
  );
}

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `heimdall-lane-models-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function byId(models: ReturnType<typeof getLaneModels>, id: string) {
  const model = models.find((entry) => entry.model_id === id);
  assert.ok(model, `model ${id} listed`);
  return model;
}

test("PANT-1322: lane models and tiers come from HEIMDALL_LANE_<N>_MODELS and HEIMDALL_LANES_JSON", () => {
  assert.deepEqual(parseLaneModels(` ${FABLE}=premium, ${OPUS} ,, ${OPUS}=premium`), [
    { id: FABLE, tier: "premium" },
    { id: OPUS, tier: "premium" },
  ]);
  assert.deepEqual(parseLaneModels(undefined), []);

  const declarations = loadLaneDeclarations({
    HEIMDALL_LANES_JSON: JSON.stringify([
      { lane_id: "a", provider: "claude", credential_ref: "A", models: [FABLE, { id: OPUS, tier: "premium" }] },
    ]),
  });
  assert.deepEqual(declarations[0].models, [{ id: FABLE }, { id: OPUS, tier: "premium" }]);
  assert.throws(
    () => loadLaneDeclarations({ HEIMDALL_LANES_JSON: JSON.stringify([{ lane_id: "a", provider: "claude", credential_ref: "A", models: [{ tier: "x" }] }]) }),
    /Invalid models/,
  );
});

test("PANT-1322: the model list merges lane config, the lane's model, the catalog (only without config) and limit-named models", () => {
  const lane = registry(`${OPUS}=premium`).get(LANE)!;
  const catalog = [
    { provider: "claude", model_id: "claude-haiku-5-5", enabled: true, provider_created_at: null, first_seen_at: "", last_seen_at: "" },
  ];
  const limits = [{
    lane_id: LANE, kind: "weekly_model:claude-sonnet-5-5" as const, scope: "model" as const, model: "claude-sonnet-5-5",
    state: "available" as const, used_percent: null, resets_at: null, reason: null, source: "passive" as const, observed_at: "",
  }];
  const models = buildLaneModels(lane, limits, [], catalog);
  assert.deepEqual(models.map((m) => [m.model_id, m.source, m.tier]), [
    [OPUS, "lane_config", "premium"],
    [FABLE, "lane_model", null],
    ["claude-sonnet-5-5", "limit", null],
  ], "declared models win; the catalog is not consulted when the lane declares models");

  const bare = { ...lane, models: [] };
  assert.deepEqual(buildLaneModels(bare, [], [], catalog).map((m) => [m.model_id, m.source]), [
    [FABLE, "lane_model"],
    ["claude-haiku-5-5", "catalog"],
  ]);
});

test("PANT-1322: available follows the limits — false after a simulated Fable limit, true after resets_at or a clear", () => {
  const reg = registry();
  const store = new StateStore(":memory:");
  try {
    const pushed = pushLaneStatus(reg, store, LANE, "out_of_credit", FABLE_MESSAGE, NOW);
    assert.equal(pushed.ok, true);

    const during = getLaneModels(reg.get(LANE)!, store, NOW);
    const fable = byId(during, FABLE);
    assert.equal(fable.available, false);
    assert.equal(fable.usable, false);
    assert.equal(fable.enabled, true, "a limit never flips the operator toggle");
    assert.deepEqual(fable.blocked_by, [`weekly_model:${FABLE}`]);
    assert.ok(fable.available_at, "the provider's reset time is carried as available_at");
    assert.equal(byId(during, OPUS).available, true, "Opus stays available on the same account");

    const afterReset = new Date(Date.parse(fable.available_at!) + 1000);
    assert.equal(byId(getLaneModels(reg.get(LANE)!, store, afterReset), FABLE).available, true);

    assert.equal(clearLaneLimit(reg, store, LANE, `weekly_model:${FABLE}`).ok, true);
    assert.equal(byId(getLaneModels(reg.get(LANE)!, store, NOW), FABLE).available, true);
  } finally {
    store.close();
  }
});

test("PANT-1322: an exhausted account-wide limit blocks every model; unknown reset leaves available_at null", () => {
  const reg = registry();
  const store = new StateStore(":memory:");
  try {
    store.recordLimit(LANE, {
      kind: "five_hour", scope: "account", model: null, state: "exhausted", used_percent: null, resets_at: null, reason: "session limit",
    }, "passive", NOW.toISOString());
    for (const model of getLaneModels(reg.get(LANE)!, store, NOW)) {
      assert.equal(model.available, false, model.model_id);
      assert.deepEqual(model.blocked_by, ["five_hour"]);
      assert.equal(model.available_at, null);
    }
  } finally {
    store.close();
  }
});

test("PANT-1322: turn Fable off and back on, one call each; auto falls back to the catalog flag", () => {
  const reg = registry();
  const store = new StateStore(":memory:");
  try {
    const off = setLaneModelEnabled(reg, store, LANE, FABLE, false, "save Fable for releases", undefined, NOW);
    assert.equal(off.ok, true);
    assert.ok(off.ok);
    assert.equal(off.model.enabled, false);
    assert.equal(off.model.manual, "disabled");
    assert.equal(off.model.override_reason, "save Fable for releases");
    assert.equal(byId(getLaneModels(reg.get(LANE)!, store, NOW), OPUS).enabled, true, "other models untouched");

    const on = setLaneModelEnabled(reg, store, LANE, FABLE, true, undefined, undefined, NOW);
    assert.ok(on.ok);
    assert.equal(on.model.enabled, true);
    assert.equal(on.model.manual, "enabled");

    store.upsertModelSeen({ provider: "claude", model_id: FABLE, default_enabled: false, provider_created_at: null, seen_at: NOW.toISOString() });
    const auto = setLaneModelEnabled(reg, store, LANE, FABLE, null, "ignored", undefined, NOW);
    assert.ok(auto.ok);
    assert.equal(auto.model.manual, null);
    assert.equal(auto.model.override_reason, null);
    assert.equal(auto.model.enabled, false, "auto follows the provider-wide catalog flag when the catalog knows the model");
  } finally {
    store.close();
  }
});

test("PANT-1322: a toggle survives a restart and expires when given an expiry", () => {
  const dbPath = tmpDbPath();
  const reg = registry();
  try {
    const until = new Date(Date.now() + 60_000).toISOString();
    let store = new StateStore(dbPath);
    assert.equal(setLaneModelEnabled(reg, store, LANE, FABLE, false).ok, true);
    assert.equal(setLaneModelEnabled(reg, store, LANE, OPUS, false, null, until).ok, true);
    store.close();

    store = new StateStore(dbPath);
    const restarted = getLaneModels(reg.get(LANE)!, store);
    assert.equal(byId(restarted, FABLE).enabled, false, "toggle persisted across a restart");
    assert.equal(byId(restarted, OPUS).enabled, false);
    assert.equal(byId(restarted, OPUS).override_until, until);

    const afterExpiry = getLaneModels(reg.get(LANE)!, store, new Date(Date.parse(until) + 1));
    assert.equal(byId(afterExpiry, OPUS).enabled, true, "expired toggle returns to auto");
    assert.equal(byId(afterExpiry, OPUS).manual, null);
    assert.equal(byId(afterExpiry, FABLE).enabled, false, "a toggle with no expiry stays");
    store.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test("PANT-1322: the expiry timer drops an expired toggle while the process runs", async () => {
  const reg = registry();
  const store = new StateStore(":memory:");
  try {
    const until = new Date(Date.now() + 150).toISOString();
    assert.equal(setLaneModelEnabled(reg, store, LANE, FABLE, false, null, until).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rows = store.database.prepare(`SELECT COUNT(*) AS n FROM lane_model_toggles`).get() as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    store.close();
  }
});

test("PANT-1322: setLaneModelEnabled validates lane, model, enabled, reason and until", () => {
  const reg = registry();
  const store = new StateStore(":memory:");
  try {
    assert.deepEqual(setLaneModelEnabled(reg, store, "nope", FABLE, false), { ok: false, error: "unknown_lane", lane_id: "nope" });
    const unknown = setLaneModelEnabled(reg, store, LANE, "gpt-6", false);
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.error, "unknown_model");
    for (const bad of [undefined, "off", 0]) {
      const result = setLaneModelEnabled(reg, store, LANE, FABLE, bad);
      assert.equal(!result.ok && result.error, "invalid_enabled", String(bad));
    }
    assert.equal((setLaneModelEnabled(reg, store, LANE, FABLE, false, 5) as { error: string }).error, "invalid_reason");
    for (const until of ["2020-01-01T00:00:00Z", "tomorrow", "2099-01-01T00:00:00"]) {
      assert.equal((setLaneModelEnabled(reg, store, LANE, FABLE, false, null, until) as { error: string }).error, "invalid_until", until);
    }
    assert.equal(store.getLaneModelToggles().length, 0, "a rejected call writes nothing");
  } finally {
    store.close();
  }
});

test("PANT-1322: GET /lanes carries models; HTTP lists and toggles a lane's models", async () => {
  const reg = registry();
  const store = new StateStore(":memory:");
  const server = createHttpServer(reg, store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://localhost:${port}`;
  try {
    const lanes = getLaneStatuses(reg, store);
    assert.deepEqual(lanes[0].models.map((m) => m.model_id), [FABLE, OPUS]);

    const off = await fetch(`${base}/lanes/${encodeURIComponent(LANE)}/models/${FABLE}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    const offBody = (await off.json()) as { ok?: boolean; model: { enabled: boolean } };
    assert.equal(offBody.model.enabled, false);
    assert.equal(offBody.ok, undefined, "the wire shape drops the internal ok flag");

    const listed = (await (await fetch(`${base}/lanes/${encodeURIComponent(LANE)}/models`)).json()) as { models: Array<{ model_id: string; enabled: boolean }> };
    assert.equal(listed.models.find((m: { model_id: string }) => m.model_id === FABLE)!.enabled, false);

    const on = await fetch(`${base}/lanes/${encodeURIComponent(LANE)}/models/${FABLE}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(((await on.json()) as { model: { enabled: boolean } }).model.enabled, true);

    const bad = await fetch(`${base}/lanes/${encodeURIComponent(LANE)}/models/${FABLE}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
    const unknown = await fetch(`${base}/lanes/${encodeURIComponent(LANE)}/models/gpt-6`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await fetch(`${base}/lanes/nope/models`)).status, 404);
  } finally {
    server.close();
    store.close();
  }
});

test("PANT-1322: MCP turns a model off and back on and lists it", async () => {
  const reg = registry();
  const store = new StateStore(":memory:");
  try {
    const dispatch = buildToolDispatch(reg, store);
    const call = async (name: string, args: unknown) => JSON.parse((await dispatchToolCall(dispatch, name, args)).content[0].text);

    const off = await call(LANES_MODELS_SET_ENABLED_TOOL_NAME, { lane_id: LANE, model_id: FABLE, enabled: false, until: "2099-01-01T00:00:00Z" });
    assert.equal(off.ok, true);
    assert.equal(off.model.enabled, false);
    assert.equal(off.model.override_until, "2099-01-01T00:00:00.000Z");

    const listed = await call(LANES_MODELS_LIST_TOOL_NAME, { lane_id: LANE });
    assert.equal(listed.models.find((m: { model_id: string }) => m.model_id === FABLE)!.enabled, false);

    const on = await call(LANES_MODELS_SET_ENABLED_TOOL_NAME, { lane_id: LANE, model_id: FABLE, enabled: true });
    assert.equal(on.model.enabled, true);

    const missing = await call(LANES_MODELS_SET_ENABLED_TOOL_NAME, { lane_id: LANE, model_id: FABLE });
    assert.equal(missing.error, "invalid_enabled", "an omitted enabled is rejected, not read as auto");
    assert.equal((await call(LANES_MODELS_LIST_TOOL_NAME, { lane_id: "nope" })).error, "unknown_lane");
    assert.deepEqual(listLaneModels(reg, store, "nope"), { ok: false, error: "unknown_lane", lane_id: "nope" });
  } finally {
    store.close();
  }
});

test("PANT-1322: the dashboard renders per-model On/Off/Auto toggles posting to /lanes/:id/models/:model", () => {
  const html = renderDashboardHtml();
  assert.match(html, /function laneModelsBlock\(lane\)/);
  assert.match(html, /data-model-toggle/);
  assert.match(html, /"\/lanes\/" \+ encodeURIComponent\(modelLaneId\) \+ "\/models\/" \+ encodeURIComponent\(modelId\)/);
  assert.match(html, /laneModelsBlock\(lane\) \+ "<\/td>"/);
});
