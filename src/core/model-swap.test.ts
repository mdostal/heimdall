// heimdall#142 slice 4: swapping to another premium model on the same lane
// when the preferred model hits a limit, and swapping back by itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getAvailableRoute,
  getModelSwapsReport,
  getRouteVerdict,
  getScoredRoute,
  listModelSwapEvents,
  useRouteLedgerPath,
  useRoutePolicyPath,
} from "./route-selector.js";
import { DEFAULT_POLICY_PATH, PolicyLoader, PolicyValidationError } from "./routing/policy-loader.js";
import { LaneRegistry, type LaneDeclaration } from "./lane-registry.js";
import { StateStore } from "./state-store.js";

useRouteLedgerPath(":memory:");

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

const LEVELS_POLICY = `
levels:
  models:
    ${FABLE}: premium
    ${OPUS}: premium
    ${SONNET}: standard
work_classes:
  build:
    levels: [premium]
  planning:
    levels: [premium, standard]
`;

function writePolicy(extra: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "heimdall-swap-policy-")), "routing-policy.yaml");
  writeFileSync(path, readFileSync(DEFAULT_POLICY_PATH, "utf8") + extra, "utf8");
  return path;
}

function withPolicy(fn: () => void, extra = LEVELS_POLICY): void {
  const path = writePolicy(extra);
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

// A Claude subscription lane: one account serving Fable (preferred) then Opus.
function subscriptionLane(lane_id: string, models: string[] = [FABLE, OPUS]): LaneDeclaration {
  return { lane_id, provider: "claude", credential_ref: `${lane_id.toUpperCase().replace(/-/g, "_")}_TOKEN`, model: models[0], models: models.map((id) => ({ id })) };
}

function registryOf(declarations: LaneDeclaration[]): LaneRegistry {
  return new LaneRegistry(declarations, { resolve: () => "secret" });
}

function up(store: StateStore, lane_id: string): void {
  store.recordStatus({ lane_id, status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
}

function exhaust(store: StateStore, laneId: string, model: string, resetsAt: string | null): string {
  const kind = `weekly_model:${model}`;
  store.recordLimit(
    laneId,
    { kind, scope: "model", model, state: "exhausted", used_percent: 100, resets_at: resetsAt, reason: `You've reached your ${model} limit` },
    "passive",
    new Date().toISOString(),
  );
  return kind;
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

function eventsFor(laneId: string) {
  return listModelSwapEvents(500).filter((event) => event.laneId === laneId);
}

test("model swap: a Fable limit makes the next build route return Opus on the same account, with the cause", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([subscriptionLane("sub-swap")]);
      up(store, "sub-swap");

      const before = getScoredRoute({ task_id: "t-1", task_type: "build" }, registry, store);
      assert.equal(before.chosen_lane, "sub-swap");
      assert.equal(before.model, FABLE);
      assert.equal(before.preferred_model, FABLE);
      assert.equal(before.model_swap, null);

      const resetsAt = hoursFromNow(3).toISOString();
      exhaust(store, "sub-swap", FABLE, resetsAt);

      const scored = getScoredRoute({ task_id: "t-2", task_type: "build" }, registry, store);
      assert.equal(scored.verdict, "route");
      assert.equal(scored.chosen_lane, "sub-swap");
      assert.equal(scored.model, OPUS);
      assert.equal(scored.preferred_model, FABLE);
      assert.equal(scored.chosen_level, "premium");
      assert.ok(scored.model_swap);
      assert.equal(scored.model_swap.cause.type, "limit");
      assert.deepEqual(scored.model_swap.cause.limits.map((limit) => limit.kind), [`weekly_model:${FABLE}`]);
      assert.equal(scored.model_swap.cause.preferred_available_at, resetsAt);
      assert.match(scored.rationale, /Model swapped on sub-swap: claude-fable-5-2 -> claude-opus-5-5/);

      const available = getAvailableRoute("build", registry, store);
      assert.equal(available?.lane_id, "sub-swap");
      assert.equal(available?.model, OPUS);
      assert.equal(available?.preferred_model, FABLE);
      assert.equal(available?.model_swap?.cause.type, "limit");

      // Logged once, in the ledger and in telemetry, with the causing limit.
      const events = eventsFor("sub-swap");
      assert.equal(events.length, 1);
      assert.equal(events[0].event, "swap");
      assert.equal(events[0].fromModel, FABLE);
      assert.equal(events[0].toModel, OPUS);
      assert.deepEqual((events[0].cause as { limits: Array<{ kind: string }> }).limits.map((limit) => limit.kind), [`weekly_model:${FABLE}`]);
      const telemetry = store.getTelemetryEventCounts("model_swap");
      assert.equal(telemetry.length, 1);
      assert.equal(telemetry[0].count, 1);
      assert.equal(telemetry[0].labels.cause, `weekly_model:${FABLE}`);
      assert.equal(telemetry[0].labels.toModel, OPUS);

      const report = getModelSwapsReport(store);
      assert.deepEqual(report.current.map((row) => [row.lane_id, row.preferred_model, row.model]), [["sub-swap", FABLE, OPUS]]);
    });
  });
});

test("model swap: once resets_at passes, routing returns to Fable by itself and logs the swap-back", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([subscriptionLane("sub-reset")]);
      up(store, "sub-reset");
      exhaust(store, "sub-reset", FABLE, hoursFromNow(1).toISOString());
      assert.equal(getScoredRoute({ task_id: "t", task_type: "build" }, registry, store).model, OPUS);

      const later = hoursFromNow(2);
      const back = getAvailableRoute("build", registry, store, { now: later });
      assert.equal(back?.model, FABLE);
      assert.equal(back?.model_swap, undefined);

      const events = eventsFor("sub-reset");
      assert.deepEqual(events.map((event) => event.event), ["swap_back", "swap"]);
      assert.equal(events[0].fromModel, OPUS);
      assert.equal(events[0].toModel, FABLE);
      assert.equal(events[0].resolution, "limit_reset");
      assert.equal(store.getTelemetryEventCounts("model_swap_back")[0]?.labels.resolution, "limit_reset");
      assert.deepEqual(getModelSwapsReport(store).current, []);
    });
  });
});

test("model swap: an operator clearing the limit returns routing to Fable with no other step", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([subscriptionLane("sub-clear")]);
      up(store, "sub-clear");
      const kind = exhaust(store, "sub-clear", FABLE, null);
      const swapped = getScoredRoute({ task_id: "t", task_type: "build" }, registry, store);
      assert.equal(swapped.model, OPUS);
      assert.equal(swapped.model_swap?.cause.preferred_available_at, null);

      assert.equal(store.clearLimit("sub-clear", kind), true);
      const back = getScoredRoute({ task_id: "t", task_type: "build" }, registry, store);
      assert.equal(back.model, FABLE);
      assert.equal(back.model_swap, null);
      assert.equal(eventsFor("sub-clear")[0].resolution, "limit_cleared");
    });
  });
});

test("model swap: each transition is logged exactly once across repeated routing calls", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([subscriptionLane("sub-once")]);
      up(store, "sub-once");
      exhaust(store, "sub-once", FABLE, hoursFromNow(1).toISOString());
      for (let i = 0; i < 5; i++) {
        getScoredRoute({ task_id: `t-${i}`, task_type: "build" }, registry, store);
        getAvailableRoute("build", registry, store);
      }
      const later = hoursFromNow(2);
      for (let i = 0; i < 5; i++) getAvailableRoute("build", registry, store, { now: later });
      assert.deepEqual(eventsFor("sub-once").map((event) => event.event), ["swap_back", "swap"]);
      assert.equal(store.getTelemetryEventCounts("model_swap")[0].count, 1);
      assert.equal(store.getTelemetryEventCounts("model_swap_back")[0].count, 1);
    });
  });
});

test("model swap: never swaps below premium; with only a standard alternative build work queues", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([subscriptionLane("sub-floor", [FABLE, SONNET])]);
      up(store, "sub-floor");
      const resetsAt = hoursFromNow(1).toISOString();
      exhaust(store, "sub-floor", FABLE, resetsAt);
      const verdict = getRouteVerdict("build", registry, store);
      assert.equal(verdict.verdict, "queue");
      assert.equal(verdict.verdict === "queue" && verdict.resets_at, resetsAt);
      const scored = getScoredRoute({ task_id: "t", task_type: "build" }, registry, store);
      assert.equal(scored.verdict, "queue");
      assert.equal(scored.model, null);
      // Even where the work class allows standard, a swap never steps below the preferred model's level.
      assert.equal(getRouteVerdict("planning", registry, store).verdict, "queue");
      assert.deepEqual(eventsFor("sub-floor"), []);
    });
  });
});

test("model swap: a premium alternative that is itself limited is not used; the queue waits for the earliest reset", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([subscriptionLane("sub-both")]);
      up(store, "sub-both");
      const fableBack = hoursFromNow(5).toISOString();
      const opusBack = hoursFromNow(2).toISOString();
      exhaust(store, "sub-both", FABLE, fableBack);
      exhaust(store, "sub-both", OPUS, opusBack);
      const verdict = getRouteVerdict("build", registry, store);
      assert.equal(verdict.verdict, "queue");
      assert.equal(verdict.verdict === "queue" && verdict.resets_at, opusBack);
    });
  });
});

test("model swap: a preferred model the operator toggled off swaps with cause model_disabled", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([subscriptionLane("sub-toggle")]);
      up(store, "sub-toggle");
      store.setLaneModelToggle("sub-toggle", FABLE, false);
      const scored = getScoredRoute({ task_id: "t", task_type: "build" }, registry, store);
      assert.equal(scored.model, OPUS);
      assert.equal(scored.model_swap?.cause.type, "model_disabled");
      store.setLaneModelToggle("sub-toggle", FABLE, true);
      assert.equal(getScoredRoute({ task_id: "t", task_type: "build" }, registry, store).model, FABLE);
      assert.equal(eventsFor("sub-toggle")[0].resolution, "model_enabled");
    });
  });
});

test("model swap: model_swap.enabled false turns swapping off (slice 3 queue behavior)", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([subscriptionLane("sub-off")]);
      up(store, "sub-off");
      exhaust(store, "sub-off", FABLE, hoursFromNow(1).toISOString());
      assert.equal(getRouteVerdict("build", registry, store).verdict, "queue");
      assert.deepEqual(eventsFor("sub-off"), []);
    });
  }, `${LEVELS_POLICY}model_swap:\n  enabled: false\n`);
});

test("model swap: without a levels section no swap happens and the verdict names the lane's model", () => {
  withStore((store) => {
    const registry = registryOf([subscriptionLane("sub-nolevels")]);
    up(store, "sub-nolevels");
    const scored = getScoredRoute({ task_id: "t", task_type: "build" }, registry, store);
    assert.equal(scored.model, FABLE);
    assert.equal(scored.model_swap, null);
  });
});

test("model swap: policy validation of model_swap", () => {
  const valid = writePolicy("model_swap:\n  enabled: false\n");
  const badValue = writePolicy("model_swap:\n  enabled: maybe\n");
  const badKey = writePolicy("model_swap:\n  enabled: true\n  floor: standard\n");
  try {
    assert.deepEqual(PolicyLoader.load(DEFAULT_POLICY_PATH).model_swap, { enabled: true });
    assert.deepEqual(PolicyLoader.load(valid).model_swap, { enabled: false });
    assert.throws(() => PolicyLoader.load(badValue), PolicyValidationError);
    assert.throws(() => PolicyLoader.load(badKey), PolicyValidationError);
  } finally {
    for (const path of [valid, badValue, badKey]) rmSync(dirname(path), { recursive: true, force: true });
  }
});
