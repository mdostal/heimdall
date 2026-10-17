import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getActiveRoutingStrategyName,
  getAvailableRoute,
  getRoutingStrategyNames,
  getScoredRoute,
  reportRouteOutcome,
  ROUTING_STRATEGY_SETTING_KEY,
  useRouteLedgerPath,
  useRoutePolicyPath,
} from "./route-selector.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_POLICY_PATH, PolicyValidationError } from "./routing/policy-loader.js";
import { LaneRegistry, type LaneDeclaration } from "./lane-registry.js";
import { StateStore } from "./state-store.js";
import type { LaneStatusValue } from "./status-model.js";

// The scored strategy's ledger defaults to the real Heimdall DB under $HOME
// (heimdall#96); keep every decision these tests make in memory instead.
useRouteLedgerPath(":memory:");

const OBSERVED_AT = "2026-09-27T12:00:00.000Z";

// A registry whose credentials all resolve, except refs listed in `missing`.
function registryOf(declarations: LaneDeclaration[], missing: string[] = []): LaneRegistry {
  return new LaneRegistry(declarations, { resolve: (ref) => (missing.includes(ref) ? null : "secret") });
}

function decl(lane_id: string, provider: string, model?: string): LaneDeclaration {
  return { lane_id, provider, credential_ref: `${lane_id.toUpperCase()}_TOKEN`, ...(model ? { model } : {}) };
}

function withStore(fn: (store: StateStore) => void): void {
  const store = new StateStore(":memory:");
  try {
    fn(store);
  } finally {
    store.close();
  }
}

function setStatus(store: StateStore, lane_id: string, status: LaneStatusValue): void {
  store.recordStatus({ lane_id, status, reset_at: null, reason: null, signal_source: "active_probe", observed_at: OBSERVED_AT });
}

function useStrategy(store: StateStore, name: string): void {
  store.setSetting(ROUTING_STRATEGY_SETTING_KEY, name);
}

test("route-selector: exposes exactly the four registered strategies", () => {
  assert.deepEqual(getRoutingStrategyNames().sort(), ["off", "priority", "round-robin", "scored"]);
});

test("route-selector: active strategy defaults to priority when unset or set to an unknown name", () => {
  withStore((store) => {
    assert.equal(getActiveRoutingStrategyName(store), "priority");
    useStrategy(store, "bogus");
    assert.equal(getActiveRoutingStrategyName(store), "priority");
    useStrategy(store, "round-robin");
    assert.equal(getActiveRoutingStrategyName(store), "round-robin");
  });
});

// --- strategies -------------------------------------------------------------

test("route-selector: priority strategy picks by task type (codex for build, claude for planning)", () => {
  const registry = registryOf([decl("claude-a", "claude"), decl("codex-a", "codex")]);
  withStore((store) => {
    setStatus(store, "claude-a", "up");
    setStatus(store, "codex-a", "up");
    assert.equal(getAvailableRoute("build", registry, store)?.lane_id, "codex-a");
    assert.equal(getAvailableRoute("planning", registry, store)?.lane_id, "claude-a");
  });
});

test("route-selector: priority route carries the lane's contract fields and no scored detail", () => {
  const registry = registryOf([decl("codex-a", "codex", "gpt-5")]);
  withStore((store) => {
    setStatus(store, "codex-a", "up");
    const route = getAvailableRoute("build", registry, store);
    assert.deepEqual(route, {
      runtime: "codex",
      model: "gpt-5",
      "token-ref": "CODEX-A_TOKEN",
      lane_id: "codex-a",
      task_type: "build",
      headroom: true,
      model_substituted: false,
    });
  });
});

test("route-selector: round-robin strategy alternates between the eligible lanes", () => {
  const registry = registryOf([decl("claude-a", "claude"), decl("codex-a", "codex")]);
  withStore((store) => {
    setStatus(store, "claude-a", "up");
    setStatus(store, "codex-a", "up");
    useStrategy(store, "round-robin");
    // The rotation cursor lives on a module-level strategy, so assert the
    // alternation rather than which lane comes first.
    const picks = [1, 2, 3, 4].map(() => getAvailableRoute("review", registry, store)?.lane_id);
    assert.deepEqual(new Set(picks.slice(0, 2)), new Set(["claude-a", "codex-a"]));
    assert.deepEqual(picks.slice(2), picks.slice(0, 2));
  });
});

test("route-selector: scored strategy returns a lane plus its decision detail", () => {
  const registry = registryOf([decl("claude-a", "claude"), decl("codex-a", "codex")]);
  withStore((store) => {
    setStatus(store, "claude-a", "up");
    setStatus(store, "codex-a", "up");
    useStrategy(store, "scored");
    const route = getAvailableRoute("build", registry, store);
    assert.ok(route, "scored strategy must pick a lane when candidates exist");
    assert.ok(["claude-a", "codex-a"].includes(route.lane_id));
    assert.equal(typeof route.decision_id, "string");
    assert.equal(typeof route.rationale, "string");
    assert.equal(typeof route.policy_version, "string");
    assert.deepEqual(route.ranked_candidates?.map((c) => c.laneId).sort(), ["claude-a", "codex-a"]);
  });
});

test("route-selector: off strategy never picks a lane", () => {
  const registry = registryOf([decl("codex-a", "codex")]);
  withStore((store) => {
    setStatus(store, "codex-a", "up");
    useStrategy(store, "off");
    assert.equal(getAvailableRoute("build", registry, store), null);
  });
});

// --- candidacy and override gating -------------------------------------------

test("route-selector: only lanes sensed up are candidates when no override is set", () => {
  const registry = registryOf([decl("codex-a", "codex"), decl("codex-b", "codex"), decl("codex-c", "codex")]);
  withStore((store) => {
    setStatus(store, "codex-a", "degraded");
    setStatus(store, "codex-b", "up");
    // codex-c has no recorded status at all.
    assert.equal(getAvailableRoute("build", registry, store)?.lane_id, "codex-b");
    setStatus(store, "codex-b", "out_of_credit");
    assert.equal(getAvailableRoute("build", registry, store), null);
  });
});

test("route-selector: manual_override disabled removes an up lane from candidacy", () => {
  const registry = registryOf([decl("codex-a", "codex"), decl("claude-a", "claude")]);
  withStore((store) => {
    setStatus(store, "codex-a", "up");
    setStatus(store, "claude-a", "up");
    store.setManualOverride("codex-a", "disabled");
    assert.equal(getAvailableRoute("build", registry, store)?.lane_id, "claude-a");
  });
});

test("route-selector: manual_override enabled forces a lane in even when it is down", () => {
  const registry = registryOf([decl("codex-a", "codex")]);
  withStore((store) => {
    setStatus(store, "codex-a", "down");
    assert.equal(getAvailableRoute("build", registry, store), null);
    store.setManualOverride("codex-a", "enabled");
    assert.equal(getAvailableRoute("build", registry, store)?.lane_id, "codex-a");
  });
});

test("route-selector: a lane whose credential didn't resolve is never routed to, even when forced enabled", () => {
  const registry = registryOf([decl("codex-a", "codex")], ["CODEX-A_TOKEN"]);
  withStore((store) => {
    setStatus(store, "codex-a", "up");
    store.setManualOverride("codex-a", "enabled");
    assert.equal(getAvailableRoute("build", registry, store), null);
  });
});

// --- model substitution -------------------------------------------------------

function seeModel(store: StateStore, provider: string, model_id: string, enabled: boolean, created: string): void {
  store.upsertModelSeen({ provider, model_id, default_enabled: enabled, provider_created_at: created, seen_at: OBSERVED_AT });
}

test("route-selector: a disabled declared model is substituted with the newest enabled one, and recorded", () => {
  const registry = registryOf([decl("claude-a", "claude", "claude-old")]);
  withStore((store) => {
    setStatus(store, "claude-a", "up");
    seeModel(store, "claude", "claude-old", false, "2025-01-01T00:00:00Z");
    seeModel(store, "claude", "claude-mid", true, "2026-01-01T00:00:00Z");
    seeModel(store, "claude", "claude-new", true, "2026-06-01T00:00:00Z");

    const route = getAvailableRoute("planning", registry, store);
    assert.equal(route?.model, "claude-new");
    assert.equal(route?.model_substituted, true);
    assert.deepEqual(store.getTelemetryEventCounts("model_substitution"), [
      {
        labels: { provider: "claude", laneId: "claude-a", declaredModel: "claude-old", effectiveModel: "claude-new" },
        count: 1,
      },
    ]);
  });
});

test("route-selector: an enabled declared model is used as-is, with no substitution event", () => {
  const registry = registryOf([decl("claude-a", "claude", "claude-old")]);
  withStore((store) => {
    setStatus(store, "claude-a", "up");
    seeModel(store, "claude", "claude-old", true, "2025-01-01T00:00:00Z");
    seeModel(store, "claude", "claude-new", true, "2026-06-01T00:00:00Z");

    const route = getAvailableRoute("planning", registry, store);
    assert.equal(route?.model, "claude-old");
    assert.equal(route?.model_substituted, false);
    assert.deepEqual(store.getTelemetryEventCounts("model_substitution"), []);
  });
});

test("route-selector: an ungated provider's declared model is never substituted", () => {
  const registry = registryOf([decl("or-a", "openrouter", "some/model")]);
  withStore((store) => {
    setStatus(store, "or-a", "up");
    seeModel(store, "openrouter", "other/model", true, "2026-06-01T00:00:00Z");
    const route = getAvailableRoute("build", registry, store);
    assert.equal(route?.model, "some/model");
    assert.equal(route?.model_substituted, false);
  });
});

// --- scored contract (POST /route) ----------------------------------------------

test("route-selector: getScoredRoute ignores the active strategy and honours override gating", () => {
  const registry = registryOf([decl("claude-a", "claude"), decl("codex-a", "codex")]);
  withStore((store) => {
    setStatus(store, "claude-a", "up");
    setStatus(store, "codex-a", "up");
    store.setManualOverride("codex-a", "disabled");
    useStrategy(store, "off");

    const result = getScoredRoute({ task_id: "route-selector-test", task_type: "build" }, registry, store);
    assert.equal(result.chosen_lane, "claude-a");
    assert.deepEqual(result.ranked_candidates.map((c) => c.laneId), ["claude-a"]);
    assert.equal(typeof result.decision_id, "string");

    assert.deepEqual(reportRouteOutcome({ decisionId: result.decision_id!, outcome: "success", actualCost: 0.01 }), { ok: true });
  });
});

test("route-selector: getScoredRoute with no candidates chooses nothing", () => {
  withStore((store) => {
    const result = getScoredRoute({ task_id: "route-selector-empty", task_type: "review" }, registryOf([]), store);
    assert.equal(result.chosen_lane, null);
    assert.deepEqual(result.ranked_candidates, []);
  });
});

test("route-selector: reportRouteOutcome rejects an unknown decision id", () => {
  assert.deepEqual(reportRouteOutcome({ decisionId: "does-not-exist" }), { ok: false, error: "unknown_decision" });
});

// --- heimdall#123: policy excluded_lanes ----------------------------------------

// The repo policy plus an excluded_lanes list. Two lanes of one provider
// family score identically (weights are per family), so only the exclusion
// can tell them apart.
const EXCLUDED = "claude@mathew.dostal";
const ALLOWED = "claude@ffevents";

function withExcludedPolicy(fn: () => void, extra = `excluded_lanes:\n  - ${EXCLUDED}\n`): void {
  const path = join(mkdtempSync(join(tmpdir(), "heimdall-excluded-policy-")), "routing-policy.yaml");
  writeFileSync(path, readFileSync(DEFAULT_POLICY_PATH, "utf8") + extra, "utf8");
  useRoutePolicyPath(path);
  try {
    fn();
  } finally {
    useRoutePolicyPath(undefined);
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

// Repo policy headroom_floor is 1000; DEFAULT_HEADROOM clears it.
function claudeLanes(allowedHeadroom?: number): LaneRegistry {
  return registryOf([
    { ...decl(ALLOWED, "claude"), ...(allowedHeadroom !== undefined ? { headroom: allowedHeadroom } : {}) },
    // priority 0 would win the priority strategy outright if it were a candidate.
    { ...decl(EXCLUDED, "claude"), priority: 0 },
  ]);
}

test("heimdall#123: getScoredRoute never chooses or ranks an excluded lane of the same provider family, and reports it withheld", () => {
  withExcludedPolicy(() =>
    withStore((store) => {
      setStatus(store, ALLOWED, "up");
      setStatus(store, EXCLUDED, "up");

      const result = getScoredRoute({ task_id: "excluded-1", task_type: "build" }, claudeLanes(), store);
      assert.equal(result.chosen_lane, ALLOWED);
      assert.deepEqual(result.ranked_candidates.map((c) => c.laneId), [ALLOWED]);
      assert.deepEqual(result.excluded_lanes, [EXCLUDED]);
      assert.match(result.rationale, new RegExp(`Withheld by policy excluded_lanes: ${EXCLUDED.replace(".", "\\.")}\\.$`));
    }),
  );
});

test("heimdall#123: when the allowed lane is below headroom_floor, getScoredRoute answers no route instead of falling back to the excluded lane", () => {
  withExcludedPolicy(() =>
    withStore((store) => {
      setStatus(store, ALLOWED, "up");
      setStatus(store, EXCLUDED, "up");

      const result = getScoredRoute({ task_id: "excluded-2", task_type: "build" }, claudeLanes(500), store);
      assert.equal(result.chosen_lane, null);
      assert.deepEqual(result.excluded_lanes, [EXCLUDED]);
      assert.match(result.rationale, /^No candidate lane meets the headroom floor \(1000\); no route chosen\. Withheld by policy/);
    }),
  );
});

test("heimdall#123: every strategy behind getAvailableRoute skips an excluded lane, even one forced enabled", () => {
  withExcludedPolicy(() => {
    for (const strategy of ["priority", "round-robin", "scored"]) {
      withStore((store) => {
        useStrategy(store, strategy);
        setStatus(store, ALLOWED, "up");
        setStatus(store, EXCLUDED, "up");
        store.setManualOverride(EXCLUDED, "enabled");

        for (let call = 0; call < 3; call++) {
          const route = getAvailableRoute("build", claudeLanes(), store);
          assert.equal(route?.lane_id, ALLOWED, `${strategy} call ${call}`);
          assert.deepEqual(route?.excluded_lanes, [EXCLUDED], strategy);
        }

        // Only the excluded lane is left healthy: no route, not a fallback.
        setStatus(store, ALLOWED, "down");
        assert.equal(getAvailableRoute("build", claudeLanes(), store), null, strategy);
      });
    }
  });
});

test("heimdall#123: a policy file that fails validation blocks routing under every strategy instead of ignoring the exclusions", () => {
  withExcludedPolicy(() => {
    withStore((store) => {
      setStatus(store, ALLOWED, "up");
      assert.throws(() => getAvailableRoute("build", claudeLanes(), store), PolicyValidationError);
    });
  }, `excluded_lanes: ${EXCLUDED}\n`);
});

test("heimdall#123: with no policy file at all, the non-scored strategies route exactly as before", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "heimdall-no-policy-")), "routing-policy.yaml");
  useRoutePolicyPath(missing);
  try {
    withStore((store) => {
      setStatus(store, ALLOWED, "up");
      setStatus(store, EXCLUDED, "up");
      const route = getAvailableRoute("build", claudeLanes(), store);
      assert.equal(route?.lane_id, EXCLUDED);
      assert.equal(route?.excluded_lanes, undefined);
    });
  } finally {
    useRoutePolicyPath(undefined);
    rmSync(dirname(missing), { recursive: true, force: true });
  }
});
