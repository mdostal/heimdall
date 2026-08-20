// hdl-bp-01: manual_headroom/manual_cost_tier precedence over LaneRegistry's
// env-var-parsed defaults in ScoredStrategy's headroom_floor gating and
// scoring — see design-discussion.md §3 item 7. No pre-existing test file
// covered ScoredStrategy.selectRoute() directly before this story (it was
// only exercised indirectly via http-server.test.ts's POST /route tests) —
// this file mirrors priority-strategy.test.ts/round-robin-strategy.test.ts's
// lane()/RouteSelectionContext helper pattern.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScoredStrategy } from "./scored-strategy.js";
import { StateStore } from "../state-store.js";
import type { Lane, LaneCostTier } from "../lane-registry.js";
import type { TaskType } from "../route-selector.js";

function lane(lane_id: string, provider: string, headroom: number, cost_tier: LaneCostTier = "medium"): Lane {
  return {
    lane_id,
    provider,
    model: provider,
    credential_ref: `${provider}_TOKEN`,
    credential: "secret",
    headroom,
    cost_tier,
  };
}

function select(strategy: ScoredStrategy, taskType: TaskType, candidates: readonly Lane[], store: StateStore) {
  return strategy.selectRoute({ taskType, candidates, store });
}

// The repo's real config/routing-policy.yaml (headroom_floor: 1000) is used
// for the headroom tests below — ScoredStrategy defaults to
// resolveDefaultPolicyPath() when no policyPath option is given, same as
// every production call site. ledgerPath is pinned to :memory: so these
// tests never touch a real DB file regardless of HEIMDALL_DB_PATH.

test("hdl-bp-01: headroom_floor gating excludes a lane whose env-var-default headroom is below the floor (unchanged pre-hdl-bp-01 behavior)", () => {
  const strategy = new ScoredStrategy({ ledgerPath: ":memory:" });
  const store = new StateStore(":memory:");
  try {
    const candidates = [lane("low-headroom", "claude", 500)];
    const result = select(strategy, "build", candidates, store);
    assert.equal(result.lane, null);
  } finally {
    store.close();
  }
});

test("hdl-bp-01: headroom_floor gating includes a lane whose env-var-default headroom is at/above the floor, with no manual value set", () => {
  const strategy = new ScoredStrategy({ ledgerPath: ":memory:" });
  const store = new StateStore(":memory:");
  try {
    const candidates = [lane("ok-headroom", "claude", 5000)];
    const result = select(strategy, "build", candidates, store);
    assert.equal(result.lane?.lane_id, "ok-headroom");
  } finally {
    store.close();
  }
});

test("hdl-bp-01: a manual_headroom override above the floor wins over a below-floor env-var default — the lane becomes selectable", () => {
  const strategy = new ScoredStrategy({ ledgerPath: ":memory:" });
  const store = new StateStore(":memory:");
  try {
    const candidates = [lane("low-headroom", "claude", 500)];
    store.setManualHeadroom("low-headroom", 5000);
    const result = select(strategy, "build", candidates, store);
    assert.equal(result.lane?.lane_id, "low-headroom");
  } finally {
    store.close();
  }
});

test("hdl-bp-01: a manual_headroom override below the floor wins over an above-floor env-var default — the lane is excluded", () => {
  const strategy = new ScoredStrategy({ ledgerPath: ":memory:" });
  const store = new StateStore(":memory:");
  try {
    const candidates = [lane("high-headroom", "claude", 5000)];
    store.setManualHeadroom("high-headroom", 10);
    const result = select(strategy, "build", candidates, store);
    assert.equal(result.lane, null);
  } finally {
    store.close();
  }
});

test("hdl-bp-01: clearing a manual_headroom override (setManualHeadroom(..., null)) falls back to the env-var default again", () => {
  const strategy = new ScoredStrategy({ ledgerPath: ":memory:" });
  const store = new StateStore(":memory:");
  try {
    const candidates = [lane("low-headroom", "claude", 500)];
    store.setManualHeadroom("low-headroom", 5000);
    store.setManualHeadroom("low-headroom", null);
    const result = select(strategy, "build", candidates, store);
    assert.equal(result.lane, null, "clearing the override should restore the below-floor env-var default's exclusion");
  } finally {
    store.close();
  }
});

test("hdl-bp-01: manual_cost_tier resolves over the env-var default and affects scored ranking", () => {
  // The default repo policy uses cost_preference: balanced, which never
  // penalizes cost_tier (scorer.ts) — a custom policy with
  // cost_preference: economy (maps to scorer.ts's "cost", per
  // COST_PREFERENCE_TO_SCORER in scored-strategy.ts) is needed to observe
  // the resolution's effect.
  const policyPath = path.join(os.tmpdir(), `heimdall-scored-strategy-cost-test-${Date.now()}.yaml`);
  fs.writeFileSync(
    policyPath,
    `version: "1.0"
task_type_weights:
  planning:
    claude: 100
  build:
    claude: 100
  review:
    claude: 100
headroom_floor: 0
cost_preference: economy
experiments:
  enabled: false
  arms:
    control:
      split: 1
`,
  );
  const strategy = new ScoredStrategy({ policyPath, ledgerPath: ":memory:" });
  const store = new StateStore(":memory:");
  try {
    // Both declared "low" (no penalty under cost_preference: economy). A
    // manual override raises lane-a to "high" — it should now incur the
    // -20 penalty and rank behind lane-b, proving the manual value (not
    // the declared "low" default) is what scoring actually used.
    const candidates = [lane("lane-a", "claude", 5000, "low"), lane("lane-b", "claude", 5000, "low")];
    store.setManualCostTier("lane-a", "high");
    const result = select(strategy, "build", candidates, store);
    assert.equal(result.lane?.lane_id, "lane-b");
  } finally {
    store.close();
    fs.rmSync(policyPath, { force: true });
  }
});
