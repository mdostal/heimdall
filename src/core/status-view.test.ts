// heimdall#142 slice 6: the limits / models / mode / swaps status view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getScoredRoute, useRouteLedgerPath, useRoutePolicyPath } from "./route-selector.js";
import { DEFAULT_POLICY_PATH } from "./routing/policy-loader.js";
import { LaneRegistry, type LaneDeclaration } from "./lane-registry.js";
import { StateStore } from "./state-store.js";
import { setMaxUsage } from "./max-usage.js";
import { evaluatePremiumAlerts, loadAlertConfig } from "./premium-alerts.js";
import { getStatusView, renderStatusText } from "./status-view.js";

useRouteLedgerPath(":memory:");

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const LANE = "ff.events";

const LEVELS_POLICY = `
levels:
  models:
    ${FABLE}: premium
    ${OPUS}: premium
    ${SONNET}: standard
work_classes:
  build:
    levels: [premium]
`;

function withPolicy(fn: () => void, extra = LEVELS_POLICY): void {
  const path = join(mkdtempSync(join(tmpdir(), "heimdall-status-policy-")), "routing-policy.yaml");
  writeFileSync(path, readFileSync(DEFAULT_POLICY_PATH, "utf8") + extra, "utf8");
  useRoutePolicyPath(path);
  try {
    fn();
  } finally {
    useRoutePolicyPath(undefined);
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

function withStore(fn: (store: StateStore) => void): void {
  const store = new StateStore(":memory:");
  try {
    fn(store);
  } finally {
    store.close();
  }
}

function ffEvents(): LaneDeclaration {
  return { lane_id: LANE, provider: "claude", credential_ref: "FF_EVENTS_TOKEN", model: FABLE, models: [FABLE, OPUS, SONNET].map((id) => ({ id })) };
}

function registryOf(declarations: LaneDeclaration[]): LaneRegistry {
  return new LaneRegistry(declarations, { resolve: () => "secret" });
}

function up(store: StateStore, lane_id: string): void {
  store.recordStatus({ lane_id, status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
}

test("status view: the ff.events lane shows limit type, state and reset, models with level, mode and last swaps", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([ffEvents()]);
      up(store, LANE);
      const now = new Date();
      const resetsAt = new Date(now.getTime() + 5 * 3_600_000).toISOString();
      store.recordLimit(LANE, { kind: `weekly_model:${FABLE}`, scope: "model", model: FABLE, state: "exhausted", used_percent: null, resets_at: resetsAt, reason: "You've reached your Fable limit" }, "passive", now.toISOString());
      store.recordLimit(LANE, { kind: "five_hour", scope: "account", model: null, state: "available", used_percent: 42, resets_at: null, reason: null }, "active_probe", now.toISOString());
      const until = new Date(now.getTime() + 24 * 3_600_000).toISOString();
      assert.equal(setMaxUsage(registry, store, LANE, { enabled: true, until, reason: "use it before reset" }, now).ok, true);

      // A build route swaps Fable -> Opus and lands in the swap ledger.
      assert.equal(getScoredRoute({ task_id: "status-1", task_type: "build" }, registry, store).model, OPUS);
      evaluatePremiumAlerts(registry, store, now, undefined, loadAlertConfig({}));

      const view = getStatusView(registry, store, { now });
      assert.equal(view.levels, "configured");
      const account = view.accounts.find((entry) => entry.lane_id === LANE);
      assert.ok(account);
      assert.equal(account.status, "up");

      const fableLimit = account.limits.find((limit) => limit.kind === `weekly_model:${FABLE}`);
      assert.deepEqual(
        fableLimit && { state: fableLimit.state, used_percent: fableLimit.used_percent, resets_at: fableLimit.resets_at },
        { state: "exhausted", used_percent: "unknown", resets_at: resetsAt },
      );
      const fiveHour = account.limits.find((limit) => limit.kind === "five_hour");
      assert.deepEqual(fiveHour && [fiveHour.state, fiveHour.used_percent, fiveHour.resets_at], ["available", 42, "unknown"]);

      const byId = new Map(account.models.map((model) => [model.model_id, model]));
      assert.deepEqual(
        [byId.get(FABLE)?.level, byId.get(FABLE)?.enabled, byId.get(FABLE)?.available, byId.get(FABLE)?.available_at],
        ["premium", true, false, resetsAt],
      );
      assert.deepEqual([byId.get(OPUS)?.level, byId.get(OPUS)?.available, byId.get(OPUS)?.available_at], ["premium", true, null]);
      assert.equal(byId.get(SONNET)?.level, "standard");

      assert.deepEqual([account.mode.max_usage, account.mode.until], [true, until]);
      assert.equal(account.current_swap?.model, OPUS);
      const swap = view.last_swaps.find((event) => event.laneId === LANE);
      assert.deepEqual(swap && [swap.event, swap.fromModel, swap.toModel], ["swap", FABLE, OPUS]);

      assert.equal(view.alerts.open.length, 1);
      assert.equal(view.alerts.open[0]!.limit_kind, `weekly_model:${FABLE}`);

      const text = renderStatusText(view);
      assert.match(text, /ff\.events \(claude\) status up/);
      assert.match(text, /weekly_model:claude-fable-5-2: exhausted, unknown %, resets /);
      assert.match(text, /max usage on until /);
      assert.match(text, /swap claude-fable-5-2 -> claude-opus-5-5/);
      assert.match(text, /OPEN ALERTS/);
      assert.ok(!text.includes("secret"), "no credential in the view");
      assert.ok(!JSON.stringify(view).includes("\"secret\""), "no credential in the JSON");
    });
  });
});

test("status view: without levels, models read unbound and mode reads off", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([ffEvents()]);
      const view = getStatusView(registry, store);
      assert.equal(view.levels, "not_configured");
      const account = view.accounts[0]!;
      assert.ok(account.models.every((model) => model.level === "unbound"));
      assert.equal(account.mode.max_usage, false);
      assert.deepEqual(account.limits, []);
    });
  }, "\n");
});
