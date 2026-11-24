// heimdall#142 slice 5: max-usage mode per account, opt-in, with expiry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAvailableRoute, getRouteVerdict, getScoredRoute, useRouteLedgerPath, useRoutePolicyPath } from "./route-selector.js";
import { DEFAULT_POLICY_PATH, PolicyLoader, PolicyValidationError } from "./routing/policy-loader.js";
import { LaneRegistry, type LaneDeclaration } from "./lane-registry.js";
import { StateStore } from "./state-store.js";
import { getMaxUsageReport, getMaxUsageStatus, PAID_SWITCH_KINDS, setMaxUsage } from "./max-usage.js";

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
const SWAP_OFF = `${LEVELS_POLICY}model_swap:
  enabled: false
`;

function withPolicy(fn: () => void, extra = LEVELS_POLICY): void {
  const path = join(mkdtempSync(join(tmpdir(), "heimdall-maxusage-policy-")), "routing-policy.yaml");
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

function lane(lane_id: string, models: string[] = [FABLE, OPUS], priority?: number): LaneDeclaration {
  return {
    lane_id,
    provider: "claude",
    credential_ref: `${lane_id.toUpperCase().replace(/-/g, "_")}_TOKEN`,
    model: models[0],
    models: models.map((id) => ({ id })),
    ...(priority !== undefined ? { priority } : {}),
  };
}

function registryOf(declarations: LaneDeclaration[]): LaneRegistry {
  return new LaneRegistry(declarations, { resolve: () => "secret" });
}

function up(store: StateStore, lane_id: string): void {
  store.recordStatus({ lane_id, status: "up", reset_at: null, reason: null, signal_source: "active_probe", observed_at: new Date().toISOString() });
}

function exhaust(store: StateStore, laneId: string, model: string, resetsAt: string | null = null): void {
  store.recordLimit(
    laneId,
    { kind: `weekly_model:${model}`, scope: "model", model, state: "exhausted", used_percent: 100, resets_at: resetsAt, reason: `You've reached your ${model} limit` },
    "passive",
    new Date().toISOString(),
  );
}

function hoursFromNow(hours: number, from = new Date()): Date {
  return new Date(from.getTime() + hours * 3_600_000);
}

function turnOn(registry: LaneRegistry, store: StateStore, laneId: string, hours = 24, now = new Date()) {
  const result = setMaxUsage(registry, store, laneId, { enabled: true, until: hoursFromNow(hours, now).toISOString(), reason: "use it before reset" }, now);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test("max usage: work moves to the next premium model as each limit is exhausted, then queues", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-a")]);
      up(store, "acct-a");
      turnOn(registry, store, "acct-a");

      const first = getScoredRoute({ task_id: "t-1", task_type: "build" }, registry, store);
      assert.equal(first.verdict, "route");
      assert.equal(first.model, FABLE);
      assert.deepEqual(first.max_usage_lanes, ["acct-a"]);

      exhaust(store, "acct-a", FABLE, hoursFromNow(5).toISOString());
      const second = getAvailableRoute("build", registry, store);
      assert.equal(second?.lane_id, "acct-a");
      assert.equal(second?.model, OPUS);
      assert.equal(second?.max_usage, true);

      exhaust(store, "acct-a", OPUS, hoursFromNow(2).toISOString());
      const third = getRouteVerdict("build", registry, store);
      assert.equal(third.verdict, "queue");
      assert.ok(third.verdict === "queue" && third.max_usage_lanes?.includes("acct-a"));
    });
  });
});

test("max usage: the swap runs for a max-usage account even when model_swap is disabled; off, behaviour is unchanged", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-b")]);
      up(store, "acct-b");
      exhaust(store, "acct-b", FABLE);

      const offBefore = getRouteVerdict("build", registry, store);
      assert.notEqual(offBefore.verdict === "route" ? offBefore.route.model : null, OPUS, "swap disabled: no move to Opus");

      turnOn(registry, store, "acct-b");
      const on = getAvailableRoute("build", registry, store);
      assert.equal(on?.model, OPUS);
      assert.equal(on?.preferred_model, FABLE);

      assert.equal(setMaxUsage(registry, store, "acct-b", { enabled: false }).ok, true);
      assert.deepEqual(getRouteVerdict("build", registry, store), offBefore);
    });
  }, SWAP_OFF);
});

test("max usage off (default): routing is identical to slice 4 and no route carries max-usage fields", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-c1", [FABLE, OPUS], 1), lane("acct-c2", [FABLE, OPUS], 2)]);
      up(store, "acct-c1");
      up(store, "acct-c2");
      assert.equal(getMaxUsageStatus(store, "acct-c1").enabled, false);
      const route = getAvailableRoute("build", registry, store);
      assert.equal(route?.max_usage, undefined);
      assert.equal(route?.max_usage_preferred, undefined);
      const scored = getScoredRoute({ task_id: "t", task_type: "build" }, registry, store);
      assert.deepEqual(scored.max_usage_lanes, []);
      assert.equal(scored.max_usage_preferred, false);
    });
  });
});

test("max usage: the max-usage account takes work ahead of other accounts until it is exhausted, then others route as normal", () => {
  withPolicy(() => {
    withStore((store) => {
      // acct-d1 would win on priority; acct-d2 is the max-usage account.
      const registry = registryOf([lane("acct-d1", [FABLE, OPUS], 1), lane("acct-d2", [FABLE, OPUS], 9)]);
      up(store, "acct-d1");
      up(store, "acct-d2");
      const before = getAvailableRoute("build", registry, store);
      assert.ok(before);

      turnOn(registry, store, "acct-d2");
      const preferred = getAvailableRoute("build", registry, store);
      assert.equal(preferred?.lane_id, "acct-d2");
      assert.equal(preferred?.max_usage_preferred, true);

      exhaust(store, "acct-d2", FABLE);
      assert.equal(getAvailableRoute("build", registry, store)?.lane_id, "acct-d2");
      assert.equal(getAvailableRoute("build", registry, store)?.model, OPUS);

      exhaust(store, "acct-d2", OPUS);
      const fallback = getAvailableRoute("build", registry, store);
      assert.equal(fallback?.lane_id, "acct-d1");
      assert.equal(fallback?.max_usage_preferred, undefined);
    });
  });
});

test("max usage: prefer_account false keeps the per-lane swap but not the account preference", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-e1", [FABLE, OPUS], 1), lane("acct-e2", [FABLE, OPUS], 9)]);
      up(store, "acct-e1");
      up(store, "acct-e2");
      const before = getAvailableRoute("build", registry, store);
      turnOn(registry, store, "acct-e2");
      const after = getAvailableRoute("build", registry, store);
      assert.equal(after?.lane_id, before?.lane_id);
      assert.equal(after?.max_usage_preferred, undefined);
    });
  }, `${LEVELS_POLICY}max_usage:\n  prefer_account: false\n`);
});

test("max usage: never routes code work below premium", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-f", [FABLE, SONNET])]);
      up(store, "acct-f");
      turnOn(registry, store, "acct-f");
      exhaust(store, "acct-f", FABLE);
      assert.equal(getRouteVerdict("build", registry, store).verdict, "queue");
      // Max usage spreads across premium models only: like the slice-4 swap it
      // never steps below the preferred model's level, even where the class allows it.
      assert.equal(getRouteVerdict("planning", registry, store).verdict, "queue");
    });
  });
});

test("max usage: expires on time, by itself, and logs it", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-g")]);
      up(store, "acct-g");
      const now = new Date();
      turnOn(registry, store, "acct-g", 2, now);
      exhaust(store, "acct-g", FABLE);
      assert.equal(getAvailableRoute("build", registry, store, { now: hoursFromNow(1, now) })?.max_usage, true);

      const later = hoursFromNow(3, now);
      assert.equal(getMaxUsageStatus(store, "acct-g", later).enabled, false);
      const route = getAvailableRoute("build", registry, store, { now: later });
      assert.equal(route?.max_usage, undefined);
      assert.equal(store.getTelemetryEventCounts("max_usage_expired")[0]?.count, 1);
    });
  }, SWAP_OFF);
});

test("max usage: persists across a restart", () => {
  withPolicy(() => {
    const dir = mkdtempSync(join(tmpdir(), "heimdall-maxusage-db-"));
    const dbPath = join(dir, "state.db");
    try {
      const registry = registryOf([lane("acct-h")]);
      const first = new StateStore(dbPath);
      const result = turnOn(registry, first, "acct-h");
      first.close();

      const reopened = new StateStore(dbPath);
      try {
        const status = getMaxUsageStatus(reopened, "acct-h");
        assert.equal(status.enabled, true);
        assert.equal(status.until, result.ok ? result.max_usage.until : null);
        assert.equal(status.reason, "use it before reset");
        assert.equal(status.effective, true);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("max usage: never changes credits or the spend cap, and refuses any request to", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-i")]);
      up(store, "acct-i");
      const observedAt = new Date().toISOString();
      store.recordLimit("acct-i", { kind: "credits", scope: "account", model: null, state: "unknown", used_percent: null, resets_at: null, reason: "extra usage off" }, "operator", observedAt);
      store.recordLimit("acct-i", { kind: "spend_cap", scope: "account", model: null, state: "exhausted", used_percent: 100, resets_at: null, reason: "monthly cap" }, "operator", observedAt);
      const paidRows = () => store.getLimits("acct-i").filter((limit) => (PAID_SWITCH_KINDS as readonly string[]).includes(limit.kind));
      const before = paidRows();
      assert.equal(before.length, 2);

      for (const field of ["credits", "enable_credits", "spend_cap", "spendCap", "budget", "overage", "raise_cap"]) {
        const refused = setMaxUsage(registry, store, "acct-i", { enabled: true, until: hoursFromNow(1).toISOString(), [field]: true });
        assert.equal(refused.ok, false);
        assert.equal(!refused.ok && refused.error, "not_a_heimdall_switch", field);
      }
      assert.equal(getMaxUsageStatus(store, "acct-i").enabled, false, "a refused request turns nothing on");

      turnOn(registry, store, "acct-i");
      exhaust(store, "acct-i", FABLE);
      exhaust(store, "acct-i", OPUS);
      getScoredRoute({ task_id: "t", task_type: "build" }, registry, store);
      getRouteVerdict("build", registry, store);
      const status = getMaxUsageStatus(store, "acct-i");
      setMaxUsage(registry, store, "acct-i", { enabled: false });

      assert.deepEqual(paidRows(), before);
      // Reported, read-only.
      assert.deepEqual(status.paid_switches.map((sw) => [sw.kind, sw.reported, sw.state]), [["credits", true, "unknown"], ["spend_cap", true, "exhausted"]]);
      assert.match(status.paid_switches_note, /never turns on paid credits or raises a spend cap/);
    });
  });
});

test("max usage: an account that never reported credits or a spend cap shows them as not reported", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-j")]);
      const report = getMaxUsageReport(registry, store);
      assert.ok(report.ok);
      assert.deepEqual(report.lanes[0].paid_switches.map((sw) => [sw.kind, sw.reported]), [["credits", false], ["spend_cap", false]]);
      assert.deepEqual(getMaxUsageReport(registry, store, "nope"), { ok: false, error: "unknown_lane", lane_id: "nope" });
    });
  });
});

test("max usage: until is required, in the future, with a timezone, and within max_usage.max_hours (12 here)", () => {
  withPolicy(() => {
    withStore((store) => {
      const registry = registryOf([lane("acct-k")]);
      const err = (input: Record<string, unknown>) => {
        const result = setMaxUsage(registry, store, "acct-k", input);
        return result.ok ? "ok" : result.error;
      };
      assert.equal(err({ enabled: true }), "invalid_until");
      assert.equal(err({ enabled: true, until: hoursFromNow(-1).toISOString() }), "invalid_until");
      assert.equal(err({ enabled: true, until: "2099-01-01T00:00:00" }), "invalid_until");
      assert.equal(err({ enabled: true, until: hoursFromNow(13).toISOString() }), "invalid_until");
      assert.equal(err({ enabled: true, until: hoursFromNow(11).toISOString() }), "ok");
      assert.equal(err({ enabled: "yes" }), "invalid_enabled");
      assert.equal(err({ enabled: true, until: hoursFromNow(1).toISOString(), reason: 5 }), "invalid_reason");
      assert.equal(err({ enabled: true, until: hoursFromNow(1).toISOString(), model: OPUS }), "unknown_field");
      assert.equal(setMaxUsage(registry, store, "ghost", { enabled: false }).ok, false);
    });
  }, `${LEVELS_POLICY}max_usage:\n  max_hours: 12\n`);
});

test("max usage: a max-usage lane with no levels configured is reported as not acting", () => {
  withStore((store) => {
    const registry = registryOf([lane("acct-l")]);
    const path = join(mkdtempSync(join(tmpdir(), "heimdall-maxusage-nolevels-")), "routing-policy.yaml");
    writeFileSync(path, readFileSync(DEFAULT_POLICY_PATH, "utf8"), "utf8");
    useRoutePolicyPath(path);
    try {
      turnOn(registry, store, "acct-l");
      const status = getMaxUsageStatus(store, "acct-l");
      assert.equal(status.enabled, true);
      assert.equal(status.effective, false);
      assert.equal(status.ineffective_reason, "levels_not_configured");
    } finally {
      useRoutePolicyPath(undefined);
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});

test("max_usage policy section: defaults, and invalid values are rejected", () => {
  const load = (extra: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "heimdall-maxusage-load-")), "routing-policy.yaml");
    writeFileSync(path, readFileSync(DEFAULT_POLICY_PATH, "utf8") + extra, "utf8");
    try {
      return PolicyLoader.load(path);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  };
  assert.deepEqual(load("").max_usage, { max_hours: 168, prefer_account: true });
  assert.deepEqual(load("max_usage:\n  max_hours: 12\n").max_usage, { max_hours: 12, prefer_account: true });
  assert.throws(() => load("max_usage:\n  max_hours: 0\n"), PolicyValidationError);
  assert.throws(() => load("max_usage:\n  prefer_account: maybe\n"), PolicyValidationError);
  assert.throws(() => load("max_usage:\n  credits: true\n"), PolicyValidationError);
});
