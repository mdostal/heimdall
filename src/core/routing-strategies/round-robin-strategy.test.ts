import { test } from "node:test";
import assert from "node:assert/strict";
import { RoundRobinStrategy } from "./round-robin-strategy.js";
import { StateStore } from "../state-store.js";
import type { Lane } from "../lane-registry.js";
import type { TaskType } from "../route-selector.js";

function lane(lane_id: string, provider: string): Lane {
  return { lane_id, provider, model: provider, credential_ref: `${provider}_TOKEN`, credential: "secret" };
}

// hdl-rr-02: selectRoute now takes a RouteSelectionContext and returns
// {lane, detail?} — this helper keeps every assertion below byte-identical
// to pre-hdl-rr-02 (still comparing a bare lane_id or null).
function pick(strategy: RoundRobinStrategy, taskType: TaskType, candidates: readonly Lane[]): string | null {
  const store = new StateStore(":memory:");
  try {
    return strategy.selectRoute({ taskType, candidates, store }).lane?.lane_id ?? null;
  } finally {
    store.close();
  }
}

test("hdl-rs-02: RoundRobinStrategy cycles through candidates, one further each call, wrapping back to the first", () => {
  const strategy = new RoundRobinStrategy();
  const candidates = [lane("a", "claude"), lane("b", "codex"), lane("c", "kimi")]; // already lane_id-sorted

  const picks = [
    pick(strategy, "build", candidates),
    pick(strategy, "build", candidates),
    pick(strategy, "build", candidates),
    pick(strategy, "build", candidates), // wraps back to "a"
  ];

  assert.deepEqual(picks, ["a", "b", "c", "a"]);
});

test("hdl-rs-02: RoundRobinStrategy sorts by lane_id first, regardless of input order — deterministic rotation order", () => {
  const strategy = new RoundRobinStrategy();
  const candidates = [lane("c", "kimi"), lane("a", "claude"), lane("b", "codex")]; // deliberately unsorted

  const first = pick(strategy, "build", candidates);
  assert.equal(first, "a", "rotation must start from lane_id-sorted order, not input order");
});

test("hdl-rs-02: RoundRobinStrategy keeps independent cursors per task type", () => {
  const strategy = new RoundRobinStrategy();
  const candidates = [lane("a", "claude"), lane("b", "codex")];

  const buildFirst = pick(strategy, "build", candidates);
  const planningFirst = pick(strategy, "planning", candidates);
  const buildSecond = pick(strategy, "build", candidates);

  assert.equal(buildFirst, "a");
  assert.equal(planningFirst, "a", "a separate task type must start its own cursor from the beginning");
  assert.equal(buildSecond, "b", "build's cursor must have advanced independently of planning's calls");
});

test("hdl-rs-02: RoundRobinStrategy returns null for zero candidates and does not advance its cursor", () => {
  const strategy = new RoundRobinStrategy();
  assert.equal(pick(strategy, "build", []), null);

  const candidates = [lane("a", "claude"), lane("b", "codex")];
  const picked = pick(strategy, "build", candidates);
  assert.equal(picked, "a", "the empty call must not have consumed a cursor position");
});

test("hdl-rs-02: a fresh RoundRobinStrategy instance starts rotation over — the accepted restart-resets-rotation tradeoff", () => {
  const first = new RoundRobinStrategy();
  const candidates = [lane("a", "claude"), lane("b", "codex")];
  pick(first, "build", candidates); // consumes "a"

  const second = new RoundRobinStrategy(); // simulates a process restart
  const picked = pick(second, "build", candidates);
  assert.equal(picked, "a", "a fresh instance must start from the beginning, not continue the prior instance's rotation");
});
