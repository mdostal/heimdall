// heimdall#142 slice 6: one alert per limit when a premium model becomes unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { useRouteLedgerPath, useRoutePolicyPath } from "./route-selector.js";
import { DEFAULT_POLICY_PATH } from "./routing/policy-loader.js";
import { LaneRegistry, type LaneDeclaration } from "./lane-registry.js";
import { StateStore } from "./state-store.js";
import {
  evaluatePremiumAlerts,
  installPremiumAlerts,
  listOperatorAlerts,
  loadAlertConfig,
  webhookNotifier,
  type PremiumAlert,
} from "./premium-alerts.js";

useRouteLedgerPath(":memory:");

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const CONFIG = loadAlertConfig({});

const LEVELS_POLICY = `
levels:
  models:
    ${FABLE}: premium
    ${OPUS}: premium
    ${SONNET}: standard
`;

function withPolicy(fn: () => void | Promise<void>, extra = LEVELS_POLICY): Promise<void> | void {
  const path = join(mkdtempSync(join(tmpdir(), "heimdall-alerts-policy-")), "routing-policy.yaml");
  writeFileSync(path, readFileSync(DEFAULT_POLICY_PATH, "utf8") + extra, "utf8");
  useRoutePolicyPath(path);
  const done = (): void => {
    useRoutePolicyPath(undefined);
    rmSync(dirname(path), { recursive: true, force: true });
  };
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    done();
    throw err;
  }
  if (result instanceof Promise) return result.finally(done);
  done();
}

function lane(lane_id: string, models: string[] = [FABLE, OPUS, SONNET]): LaneDeclaration {
  return {
    lane_id,
    provider: "claude",
    credential_ref: `${lane_id.toUpperCase().replace(/[-.]/g, "_")}_TOKEN`,
    model: models[0],
    models: models.map((id) => ({ id })),
  };
}

function registryOf(declarations: LaneDeclaration[]): LaneRegistry {
  return new LaneRegistry(declarations, { resolve: () => "secret" });
}

function up(store: StateStore, lane_id: string): void {
  store.recordStatus({ lane_id, status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
}

function exhaustFable(store: StateStore, laneId: string, resetsAt: string | null, observedAt = new Date()): void {
  store.recordLimit(
    laneId,
    { kind: `weekly_model:${FABLE}`, scope: "model", model: FABLE, state: "exhausted", used_percent: null, resets_at: resetsAt, reason: "You've reached your Fable limit" },
    "passive",
    observedAt.toISOString(),
  );
}

const LANE = "ff.events";

test("alerts: a simulated Fable limit raises exactly one alert with the choices", () =>
  withPolicy(() => {
    const store = new StateStore(":memory:");
    try {
      const registry = registryOf([lane(LANE)]);
      up(store, LANE);
      const now = new Date();
      const resetsAt = new Date(now.getTime() + 6 * 3_600_000).toISOString();
      const notified: PremiumAlert[] = [];
      const notify = (alert: PremiumAlert): void => {
        notified.push(alert);
      };
      const bus: unknown[] = [];
      store.events.onOperatorAlert((alert) => bus.push(alert));

      // The same limit reported three times, evaluated after each report and again later.
      exhaustFable(store, LANE, resetsAt, now);
      const first = evaluatePremiumAlerts(registry, store, now, notify, CONFIG);
      exhaustFable(store, LANE, resetsAt, new Date(now.getTime() + 1_000));
      evaluatePremiumAlerts(registry, store, new Date(now.getTime() + 1_000), notify, CONFIG);
      exhaustFable(store, LANE, resetsAt, new Date(now.getTime() + 2_000));
      evaluatePremiumAlerts(registry, store, new Date(now.getTime() + 2_000), notify, CONFIG);
      evaluatePremiumAlerts(registry, store, new Date(now.getTime() + 60_000), notify, CONFIG);

      assert.equal(first.raised.length, 1);
      assert.equal(notified.length, 1, "one limit, one notification");
      assert.equal(bus.length, 1, "one in-process alert event");
      const open = listOperatorAlerts(store, { openOnly: true });
      assert.equal(open.length, 1, "one open alert");

      const alert = notified[0]!;
      assert.equal(alert.type, "premium_unavailable");
      assert.equal(alert.lane_id, LANE);
      assert.equal(alert.limit_kind, `weekly_model:${FABLE}`);
      assert.deepEqual(alert.models, [{ model_id: FABLE, level: "premium" }]);
      assert.equal(alert.limit.used_percent, "unknown", "no estimated usage numbers");
      assert.equal(alert.limit.resets_at, resetsAt);

      const actions = alert.choices.map((choice) => choice.action);
      assert.deepEqual(actions, ["swap", "wait", "human_reset"], "no credits choice without a credits limit");
      const swap = alert.choices[0]!;
      assert.ok(swap.action === "swap" && swap.available);
      assert.deepEqual(
        swap.action === "swap" ? swap.options : [],
        [{ lane_id: LANE, model_id: OPUS, level: "premium", same_account: true }],
        "swap offers the other premium model, not the standard one",
      );
      const wait = alert.choices[1]!;
      assert.ok(wait.action === "wait" && wait.until === resetsAt);
      const reset = alert.choices[2]!;
      assert.ok(reset.action === "human_reset" && reset.path === "/lanes/ff.events/limits/clear" && reset.body.kind === `weekly_model:${FABLE}`);
      assert.match(alert.message, /claude-fable-5-2 unavailable on ff\.events/);
      assert.match(alert.message, /swap to claude-opus-5-5/);

      const telemetry = store.getTelemetryEventCounts("operator_alert");
      assert.equal(telemetry.reduce((sum, row) => sum + row.count, 0), 1);
    } finally {
      store.close();
    }
  }));

test("alerts: the alert resolves at reset and a new exhaustion is a new alert", () =>
  withPolicy(() => {
    const store = new StateStore(":memory:");
    try {
      const registry = registryOf([lane(LANE)]);
      up(store, LANE);
      const now = new Date();
      const resetsAt = new Date(now.getTime() + 3_600_000).toISOString();
      exhaustFable(store, LANE, resetsAt, now);
      assert.equal(evaluatePremiumAlerts(registry, store, now, undefined, CONFIG).raised.length, 1);

      const afterReset = new Date(now.getTime() + 2 * 3_600_000);
      const pass = evaluatePremiumAlerts(registry, store, afterReset, undefined, CONFIG);
      assert.deepEqual(pass.resolved.map((r) => r.resolution), ["limit_reset"]);
      assert.equal(listOperatorAlerts(store, { openOnly: true }).length, 0);

      const nextReset = new Date(afterReset.getTime() + 7 * 24 * 3_600_000).toISOString();
      exhaustFable(store, LANE, nextReset, afterReset);
      assert.equal(evaluatePremiumAlerts(registry, store, afterReset, undefined, CONFIG).raised.length, 1);

      store.clearLimit(LANE, `weekly_model:${FABLE}`);
      const cleared = evaluatePremiumAlerts(registry, store, afterReset, undefined, CONFIG);
      assert.deepEqual(cleared.resolved.map((r) => r.resolution), ["limit_cleared"]);
      assert.equal(listOperatorAlerts(store).length, 2);
    } finally {
      store.close();
    }
  }));

test("alerts: an account-wide limit is one alert listing every premium model, credits offered when reported", () =>
  withPolicy(() => {
    const store = new StateStore(":memory:");
    try {
      const registry = registryOf([lane(LANE), lane("backup", [OPUS])]);
      up(store, LANE);
      up(store, "backup");
      const now = new Date();
      store.recordLimit(LANE, { kind: "five_hour", scope: "account", model: null, state: "exhausted", used_percent: 100, resets_at: null, reason: "5-hour limit reached" }, "passive", now.toISOString());
      store.recordLimit(LANE, { kind: "credits", scope: "account", model: null, state: "unknown", used_percent: null, resets_at: null, reason: null }, "passive", now.toISOString());
      const { raised } = evaluatePremiumAlerts(registry, store, now, undefined, CONFIG);
      assert.equal(raised.length, 1);
      const alert = raised[0]!;
      assert.deepEqual(alert.models.map((m) => m.model_id), [FABLE, OPUS]);
      const wait = alert.choices.find((c) => c.action === "wait");
      assert.ok(wait && wait.action === "wait" && wait.until === "unknown");
      const swap = alert.choices.find((c) => c.action === "swap");
      assert.deepEqual(swap && swap.action === "swap" ? swap.options : [], [{ lane_id: "backup", model_id: OPUS, level: "premium", same_account: false }]);
      assert.ok(alert.choices.some((c) => c.action === "credits"));
    } finally {
      store.close();
    }
  }));

test("alerts: a disabled or non-premium model raises nothing", () =>
  withPolicy(() => {
    const store = new StateStore(":memory:");
    try {
      const registry = registryOf([lane(LANE)]);
      up(store, LANE);
      const now = new Date();
      store.setLaneModelToggle(LANE, FABLE, false, "off by hand", null, now);
      exhaustFable(store, LANE, null, now);
      store.recordLimit(LANE, { kind: `weekly_model:${SONNET}`, scope: "model", model: SONNET, state: "exhausted", used_percent: null, resets_at: null, reason: null }, "passive", now.toISOString());
      assert.equal(evaluatePremiumAlerts(registry, store, now, undefined, CONFIG).raised.length, 0);
    } finally {
      store.close();
    }
  }));

test("alerts: installPremiumAlerts raises on the limit change itself, once", () =>
  withPolicy(() => {
    const store = new StateStore(":memory:");
    const registry = registryOf([lane(LANE)]);
    up(store, LANE);
    const notified: PremiumAlert[] = [];
    const stop = installPremiumAlerts(registry, store, { env: {}, notify: (alert) => void notified.push(alert) });
    try {
      const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
      exhaustFable(store, LANE, resetsAt);
      exhaustFable(store, LANE, resetsAt, new Date(Date.now() + 1));
      assert.equal(notified.length, 1);
    } finally {
      stop();
      store.close();
    }
  }));

test("alerts: the webhook notifier never puts the URL in its error", async () => {
  const url = "https://hooks.example.test/secret-token-123";
  const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(webhookNotifier(url, failing)({} as PremiumAlert), (err: Error) => {
    assert.ok(!err.message.includes("secret-token-123"));
    return true;
  });
  const seen: Array<{ url: string; body: string }> = [];
  const ok = (async (target: string, init: RequestInit) => {
    seen.push({ url: target, body: String(init.body) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  await webhookNotifier(url, ok)({ id: 7 } as PremiumAlert);
  assert.equal(seen.length, 1);
  assert.equal(JSON.parse(seen[0]!.body).id, 7);
});

test("alerts: config comes from env", () => {
  assert.deepEqual(loadAlertConfig({}).levels, ["premium"]);
  assert.deepEqual(loadAlertConfig({ HEIMDALL_ALERT_LEVELS: "premium, standard, bogus" }).levels, ["premium", "standard"]);
  assert.equal(loadAlertConfig({ HEIMDALL_ALERT_EVAL_INTERVAL_MS: "5000" }).evalIntervalMs, 5000);
  assert.equal(loadAlertConfig({ HEIMDALL_ALERT_EVAL_INTERVAL_MS: "10" }).evalIntervalMs, 30_000);
  assert.equal(loadAlertConfig({ HEIMDALL_ALERT_WEBHOOK_URL: " " }).webhookUrl, null);
});
