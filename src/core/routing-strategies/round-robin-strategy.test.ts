import { test } from "node:test";
import assert from "node:assert/strict";
import { RoundRobinStrategy } from "./round-robin-strategy.js";
import type { Lane } from "../lane-registry.js";

function lane(lane_id: string, provider: string): Lane {
  return { lane_id, provider, model: provider, credential_ref: `${provider}_TOKEN`, credential: "secret" };
}

test("hdl-rs-02: RoundRobinStrategy cycles through candidates, one further each call, wrapping back to the first", () => {
  const strategy = new RoundRobinStrategy();
  const candidates = [lane("a", "claude"), lane("b", "codex"), lane("c", "kimi")]; // already lane_id-sorted

  const picks = [
    strategy.selectRoute("build", candidates)?.lane_id,
    strategy.selectRoute("build", candidates)?.lane_id,
    strategy.selectRoute("build", candidates)?.lane_id,
    strategy.selectRoute("build", candidates)?.lane_id, // wraps back to "a"
  ];

  assert.deepEqual(picks, ["a", "b", "c", "a"]);
});

test("hdl-rs-02: RoundRobinStrategy sorts by lane_id first, regardless of input order — deterministic rotation order", () => {
  const strategy = new RoundRobinStrategy();
  const candidates = [lane("c", "kimi"), lane("a", "claude"), lane("b", "codex")]; // deliberately unsorted

  const first = strategy.selectRoute("build", candidates);
  assert.equal(first?.lane_id, "a", "rotation must start from lane_id-sorted order, not input order");
});

test("hdl-rs-02: RoundRobinStrategy keeps independent cursors per task type", () => {
  const strategy = new RoundRobinStrategy();
  const candidates = [lane("a", "claude"), lane("b", "codex")];

  const buildFirst = strategy.selectRoute("build", candidates)?.lane_id;
  const planningFirst = strategy.selectRoute("planning", candidates)?.lane_id;
  const buildSecond = strategy.selectRoute("build", candidates)?.lane_id;

  assert.equal(buildFirst, "a");
  assert.equal(planningFirst, "a", "a separate task type must start its own cursor from the beginning");
  assert.equal(buildSecond, "b", "build's cursor must have advanced independently of planning's calls");
});

test("hdl-rs-02: RoundRobinStrategy returns null for zero candidates and does not advance its cursor", () => {
  const strategy = new RoundRobinStrategy();
  assert.equal(strategy.selectRoute("build", []), null);

  const candidates = [lane("a", "claude"), lane("b", "codex")];
  const picked = strategy.selectRoute("build", candidates);
  assert.equal(picked?.lane_id, "a", "the empty call must not have consumed a cursor position");
});

test("hdl-rs-02: a fresh RoundRobinStrategy instance starts rotation over — the accepted restart-resets-rotation tradeoff", () => {
  const first = new RoundRobinStrategy();
  const candidates = [lane("a", "claude"), lane("b", "codex")];
  first.selectRoute("build", candidates); // consumes "a"

  const second = new RoundRobinStrategy(); // simulates a process restart
  const picked = second.selectRoute("build", candidates);
  assert.equal(picked?.lane_id, "a", "a fresh instance must start from the beginning, not continue the prior instance's rotation");
});
