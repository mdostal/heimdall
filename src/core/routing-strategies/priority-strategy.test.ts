import { test } from "node:test";
import assert from "node:assert/strict";
import { PriorityStrategy } from "./priority-strategy.js";
import type { Lane } from "../lane-registry.js";

function lane(lane_id: string, provider: string): Lane {
  return { lane_id, provider, model: provider, credential_ref: `${provider}_TOKEN`, credential: "secret" };
}

test("hdl-rs-02: PriorityStrategy picks by RUNTIME_PRIORITY.build order (codex first) — matches pre-hdl-rs-02 inline behavior exactly", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("claude@mathew.dostal", "claude"), lane("codex", "codex"), lane("kimi", "kimi")];
  const picked = strategy.selectRoute("build", candidates);
  assert.equal(picked?.lane_id, "codex");
});

test("hdl-rs-02: PriorityStrategy picks by RUNTIME_PRIORITY.planning order (claude first)", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("codex", "codex"), lane("claude@mathew.dostal", "claude"), lane("kimi", "kimi")];
  const picked = strategy.selectRoute("planning", candidates);
  assert.equal(picked?.lane_id, "claude@mathew.dostal");
});

test("hdl-rs-02: PriorityStrategy breaks ties by lane_id (alphabetical) when two candidates share the same provider rank", () => {
  const strategy = new PriorityStrategy();
  // Two lanes on the same provider — RUNTIME_PRIORITY ranks by provider, so
  // these tie and must fall back to lane_id ordering.
  const candidates = [lane("codex-b", "codex"), lane("codex-a", "codex")];
  const picked = strategy.selectRoute("build", candidates);
  assert.equal(picked?.lane_id, "codex-a");
});

test("hdl-rs-02: PriorityStrategy returns null for zero candidates", () => {
  const strategy = new PriorityStrategy();
  assert.equal(strategy.selectRoute("build", []), null);
});

test("hdl-rs-02: PriorityStrategy ranks an unlisted provider last, not first", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("mystery", "some-unlisted-provider"), lane("kimi", "kimi")];
  const picked = strategy.selectRoute("build", candidates);
  assert.equal(picked?.lane_id, "kimi", "kimi is in RUNTIME_PRIORITY.build; an unlisted provider must rank behind every listed one");
});
