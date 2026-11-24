// heimdall#142 slice 3: routing through the level gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getAvailableRoute,
  getRouteVerdict,
  getRoutingStrategyNames,
  getScoredRoute,
  ROUTING_STRATEGY_SETTING_KEY,
  useRouteLedgerPath,
  useRoutePolicyPath,
} from "./route-selector.js";
import { DEFAULT_POLICY_PATH, PolicyValidationError } from "./routing/policy-loader.js";
import { LaneRegistry, type LaneDeclaration } from "./lane-registry.js";
import { StateStore } from "./state-store.js";
import type { LaneStatusValue } from "./status-model.js";

useRouteLedgerPath(":memory:");

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

const LEVELS_POLICY = `
levels:
  models:
    ${FABLE}: premium
    ${OPUS}: premium
    ${SONNET}: standard
    ${HAIKU}: economy
  lanes:
    legacy: premium
work_classes:
  build:
    levels: [premium]
  planning:
    levels: [premium, standard]
  summaries:
    levels: [economy]
`;

function withPolicy(fn: () => void, extra = LEVELS_POLICY): void {
  const path = join(mkdtempSync(join(tmpdir(), "heimdall-levels-policy-")), "routing-policy.yaml");
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

function registryOf(declarations: LaneDeclaration[]): LaneRegistry {
  return new LaneRegistry(declarations, { resolve: () => "secret" });
}

function decl(lane_id: string, model: string, extra: Partial<LaneDeclaration> = {}): LaneDeclaration {
  return { lane_id, provider: "claude", credential_ref: `${lane_id.toUpperCase()}_TOKEN`, model, ...extra };
}

function setStatus(store: StateStore, lane_id: string, status: LaneStatusValue, reset_at: string | null = null): void {
  store.recordStatus({ lane_id, status, reset_at, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
}

function exhaust(store: StateStore, laneId: string, model: string, resetsAt: string | null): void {
  store.recordLimit(
    laneId,
    { kind: `weekly_model:${model}`, scope: "model", model, state: "exhausted", used_percent: 100, resets_at: resetsAt, reason: `You've reached your ${model} limit` },
    "passive",
    new Date().toISOString(),
  );
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

// Every lower-level lane is set up to WIN each strategy if it were a
// candidate: priority 0 for the priority strategy, more headroom for scored,
// and alphabetically first for the priority tie-break.
function mixedFleet(): LaneRegistry {
  return registryOf([
    decl("a-sonnet", SONNET, { priority: 0, headroom: 99999, cost_tier: "low" }),
    decl("b-haiku", HAIKU, { priority: 0, headroom: 99999, cost_tier: "low" }),
    decl("c-unbound", "gpt-codex", { priority: 0, headroom: 99999, cost_tier: "low" }),
    decl("y-opus", OPUS, { priority: 5 }),
    decl("z-fable", FABLE, { priority: 5 }),
  ]);
}

function allUp(store: StateStore, registry: LaneRegistry): void {
  for (const lane of registry.list()) setStatus(store, lane.lane_id, "up");
}

const PREMIUM_LANES = new Set(["y-opus", "z-fable"]);

test("levels: a premium-only work class never gets a standard, economy or unbound model, under every strategy", () => {
  withPolicy(() => {
    for (const strategy of getRoutingStrategyNames()) {
      withStore((store) => {
        store.setSetting(ROUTING_STRATEGY_SETTING_KEY, strategy);
        const registry = mixedFleet();
        allUp(store, registry);
        // Force the lower-level lanes in: the gate must win over a manual "enabled" too.
        store.setManualOverride("a-sonnet", "enabled");
        store.setManualOverride("b-haiku", "enabled");

        for (const taskType of ["build", "review"] as const) {
          for (const workClass of [undefined, "release", "code", "planning", "summaries"]) {
            for (let call = 0; call < 4; call++) {
              const label = `${strategy} ${taskType} ${workClass ?? "-"} #${call}`;
              const route = getAvailableRoute(taskType, registry, store, { workClass });
              if (strategy === "off") {
                assert.equal(route, null, label);
              } else {
                assert.ok(route && PREMIUM_LANES.has(route.lane_id), `${label}: got ${route?.lane_id}`);
                assert.equal(route.level, "premium", label);
                assert.deepEqual(route.allowed_levels, ["premium"], label);
              }
              const scored = getScoredRoute({ task_id: `t-${call}`, task_type: taskType, work_class: workClass }, registry, store);
              assert.ok(scored.chosen_lane && PREMIUM_LANES.has(scored.chosen_lane), `${label} scored: got ${scored.chosen_lane}`);
              assert.ok(scored.ranked_candidates.every((c) => PREMIUM_LANES.has(c.laneId)), `${label} ranked`);
              assert.equal(scored.chosen_level, "premium", label);
            }
          }
        }

        // Now every premium model is exhausted: queue, never a lower lane.
        exhaust(store, "y-opus", OPUS, hoursFromNow(5));
        exhaust(store, "z-fable", FABLE, hoursFromNow(2));
        for (const taskType of ["build", "review"] as const) {
          for (const workClass of [undefined, "release", "code", "planning", "summaries"]) {
            const label = `${strategy} exhausted ${taskType} ${workClass ?? "-"}`;
            assert.equal(getAvailableRoute(taskType, registry, store, { workClass }), null, label);
            const verdict = getRouteVerdict(taskType, registry, store, { workClass });
            assert.equal(verdict.verdict, "queue", label);
            const scored = getScoredRoute({ task_id: "t", task_type: taskType, work_class: workClass }, registry, store);
            assert.equal(scored.chosen_lane, null, label);
            assert.equal(scored.verdict, "queue", label);
            assert.deepEqual(scored.ranked_candidates, [], label);
          }
        }
      });
    }
  });
});

test("levels: with every premium model exhausted, build work gets queue plus the earliest reset time", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = mixedFleet();
      allUp(store, registry);
      const fableReset = hoursFromNow(2);
      exhaust(store, "y-opus", OPUS, hoursFromNow(30));
      exhaust(store, "z-fable", FABLE, fableReset);

      const verdict = getRouteVerdict("build", registry, store);
      assert.equal(verdict.verdict, "queue");
      if (verdict.verdict !== "queue") return;
      assert.equal(verdict.resets_at, fableReset);
      assert.equal(verdict.work_class, "build");
      assert.deepEqual(verdict.allowed_levels, ["premium"]);
      const byLane = Object.fromEntries(verdict.level_withheld.map((entry) => [entry.lane_id, entry]));
      assert.equal(byLane["a-sonnet"].reason, "level_not_allowed");
      assert.equal(byLane["a-sonnet"].level, "standard");
      assert.equal(byLane["b-haiku"].reason, "level_not_allowed");
      assert.equal(byLane["c-unbound"].reason, "unbound");
      assert.equal(byLane["z-fable"].reason, "model_unavailable");
      assert.equal(byLane["z-fable"].available_at, fableReset);

      const scored = getScoredRoute({ task_id: "build-1", task_type: "build" }, registry, store);
      assert.equal(scored.verdict, "queue");
      assert.equal(scored.resets_at, fableReset);
      assert.match(scored.rationale, /queued until/);
      assert.match(scored.rationale, /never routed to a lower level/);
    });
  });
});

test("levels: the queue's reset time also comes from a down premium lane's reset_at; unknown resets give null", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([decl("y-opus", OPUS), decl("z-fable", FABLE), decl("a-sonnet", SONNET)]);
      const laneReset = hoursFromNow(1);
      setStatus(store, "y-opus", "out_of_credit", laneReset);
      setStatus(store, "z-fable", "up");
      setStatus(store, "a-sonnet", "up");
      exhaust(store, "z-fable", FABLE, null);
      const verdict = getRouteVerdict("build", registry, store);
      assert.equal(verdict.verdict, "queue");
      assert.equal(verdict.verdict === "queue" && verdict.resets_at, laneReset);

      setStatus(store, "y-opus", "down", null);
      const unknown = getRouteVerdict("build", registry, store);
      assert.equal(unknown.verdict === "queue" && unknown.resets_at, null);
    });
  });
});

test("levels: Fable exhausted leaves Opus routable for build; once Fable's limit resets it routes again", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([decl("z-fable", FABLE, { priority: 0 }), decl("y-opus", OPUS, { priority: 1 }), decl("a-sonnet", SONNET, { priority: 0 })]);
      allUp(store, registry);
      assert.equal(getAvailableRoute("build", registry, store)?.lane_id, "z-fable");
      exhaust(store, "z-fable", FABLE, hoursFromNow(1));
      assert.equal(getAvailableRoute("build", registry, store)?.lane_id, "y-opus");
      // At a time past the reset, the limit no longer blocks.
      assert.equal(getAvailableRoute("build", registry, store, { now: new Date(Date.now() + 2 * 3_600_000) })?.lane_id, "z-fable");
    });
  });
});

test("levels: a premium model the operator toggled off is withheld, not stepped down from", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([decl("z-fable", FABLE), decl("a-sonnet", SONNET)]);
      allUp(store, registry);
      store.setLaneModelToggle("z-fable", FABLE, false);
      const verdict = getRouteVerdict("build", registry, store);
      assert.equal(verdict.verdict, "queue");
      assert.equal(verdict.verdict === "queue" && verdict.level_withheld.find((e) => e.lane_id === "z-fable")?.reason, "model_disabled");
    });
  });
});

test("levels: lower levels are opt-in per work class", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([decl("a-sonnet", SONNET), decl("b-haiku", HAIKU)]);
      allUp(store, registry);
      // planning opts in to standard.
      const planning = getAvailableRoute("planning", registry, store);
      assert.equal(planning?.lane_id, "a-sonnet");
      assert.equal(planning?.level, "standard");
      assert.equal(planning?.work_class, "planning");
      // summaries opts in to economy only.
      assert.equal(getAvailableRoute("planning", registry, store, { workClass: "summaries" })?.lane_id, "b-haiku");
      // An unlisted class gets premium only.
      assert.equal(getRouteVerdict("planning", registry, store, { workClass: "triage" }).verdict, "queue");
    });
  });
});

test("levels: a lane's own model tier and a policy lane binding both bind levels", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([
        decl("tiered", "gpt-6-astra", { models: [{ id: "gpt-6-astra", tier: "premium" }] }),
        { lane_id: "legacy", provider: "claude", credential_ref: "LEGACY_TOKEN" },
      ]);
      allUp(store, registry);
      store.setManualOverride("legacy", "disabled");
      assert.equal(getAvailableRoute("build", registry, store)?.lane_id, "tiered");
      store.setManualOverride("legacy", null);
      store.setManualOverride("tiered", "disabled");
      const route = getAvailableRoute("build", registry, store);
      assert.equal(route?.lane_id, "legacy");
      assert.equal(route?.level, "premium");
    });
  });
});

test("levels: an invalid level config blocks routing under every strategy", () => {
  const registry = registryOf([decl("z-fable", FABLE)]);
  const invalid = [
    `levels:\n  models:\n    ${FABLE}: gold\n`,
    `levels:\n  models: {}\nwork_classes:\n  build:\n    levels: [premium, standard]\n`,
    `work_classes:\n  planning:\n    levels: [premium]\n`,
  ];
  for (const extra of invalid) {
    withPolicy(() => {
      for (const strategy of getRoutingStrategyNames()) {
        withStore((store) => {
          store.setSetting(ROUTING_STRATEGY_SETTING_KEY, strategy);
          setStatus(store, "z-fable", "up");
          assert.throws(() => getAvailableRoute("build", registry, store), PolicyValidationError, `${strategy}: ${extra}`);
          assert.throws(() => getScoredRoute({ task_id: "t", task_type: "build" }, registry, store), PolicyValidationError);
        });
      }
    }, extra);
  }

  // A lane tier that isn't a level blocks routing too, once levels are on.
  withPolicy(() => {
    withStore((store) => {
      const tiered = registryOf([decl("z-fable", FABLE, { models: [{ id: FABLE, tier: "flagship" }] })]);
      setStatus(store, "z-fable", "up");
      assert.throws(() => getAvailableRoute("build", tiered, store), /Invalid tier "flagship"/);
    });
  });
});

test("levels: without a levels section, routing and the route contract are unchanged", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([decl("a-sonnet", SONNET)]);
      allUp(store, registry);
      const route = getAvailableRoute("build", registry, store);
      assert.equal(route?.lane_id, "a-sonnet");
      assert.equal(route && "level" in route, false);
      const scored = getScoredRoute({ task_id: "t", task_type: "build" }, registry, store);
      assert.equal(scored.verdict, "route");
      assert.equal(scored.work_class, null);
      assert.equal(scored.allowed_levels, null);
      assert.equal(scored.chosen_level, null);
      assert.deepEqual(scored.level_withheld, []);
    });
  }, "");
});

test("levels: the 'off' strategy declining to pick is no_route, not a queue", () => {
  withPolicy(() => {
    withStore((store) => {
      store.setSetting(ROUTING_STRATEGY_SETTING_KEY, "off");
      const registry = registryOf([decl("z-fable", FABLE)]);
      allUp(store, registry);
      assert.equal(getRouteVerdict("build", registry, store).verdict, "no_route");
    });
  });
});
