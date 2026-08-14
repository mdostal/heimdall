import { test } from "node:test";
import assert from "node:assert/strict";
import { PriorityStrategy } from "./priority-strategy.js";
import { StateStore } from "../state-store.js";
import type { Lane } from "../lane-registry.js";
import type { TaskType } from "../route-selector.js";

function lane(lane_id: string, provider: string, priority?: number): Lane {
  return {
    lane_id,
    provider,
    model: provider,
    credential_ref: `${provider}_TOKEN`,
    credential: "secret",
    ...(priority !== undefined ? { priority } : {}),
  };
}

// hdl-rr-02: selectRoute now takes a RouteSelectionContext and returns
// {lane, detail?} — this helper keeps every assertion below byte-identical
// to pre-hdl-rr-02 (still comparing picked?.lane_id).
function select(strategy: PriorityStrategy, taskType: TaskType, candidates: readonly Lane[]) {
  const store = new StateStore(":memory:");
  try {
    return strategy.selectRoute({ taskType, candidates, store }).lane;
  } finally {
    store.close();
  }
}

test("hdl-rs-02: PriorityStrategy picks by RUNTIME_PRIORITY.build order (codex first) — matches pre-hdl-rs-02 inline behavior exactly", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("claude@mathew.dostal", "claude"), lane("codex", "codex"), lane("kimi", "kimi")];
  const picked = select(strategy, "build", candidates);
  assert.equal(picked?.lane_id, "codex");
});

test("hdl-rs-02: PriorityStrategy picks by RUNTIME_PRIORITY.planning order (claude first)", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("codex", "codex"), lane("claude@mathew.dostal", "claude"), lane("kimi", "kimi")];
  const picked = select(strategy, "planning", candidates);
  assert.equal(picked?.lane_id, "claude@mathew.dostal");
});

test("hdl-rs-02: PriorityStrategy breaks ties by lane_id (alphabetical) when two candidates share the same provider rank", () => {
  const strategy = new PriorityStrategy();
  // Two lanes on the same provider — RUNTIME_PRIORITY ranks by provider, so
  // these tie and must fall back to lane_id ordering.
  const candidates = [lane("codex-b", "codex"), lane("codex-a", "codex")];
  const picked = select(strategy, "build", candidates);
  assert.equal(picked?.lane_id, "codex-a");
});

test("hdl-rs-02: PriorityStrategy returns null for zero candidates", () => {
  const strategy = new PriorityStrategy();
  assert.equal(select(strategy, "build", []), null);
});

test("hdl-rs-02: PriorityStrategy ranks an unlisted provider last, not first", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("mystery", "some-unlisted-provider"), lane("kimi", "kimi")];
  const picked = select(strategy, "build", candidates);
  assert.equal(picked?.lane_id, "kimi", "kimi is in RUNTIME_PRIORITY.build; an unlisted provider must rank behind every listed one");
});

test("hdl-or-04: two same-provider lanes with no priority set still tie and break by lane_id — byte-identical to pre-hdl-or-04 behavior", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("openrouter-kimi", "openrouter"), lane("openrouter-grok", "openrouter")];
  const picked = select(strategy, "build", candidates);
  assert.equal(picked?.lane_id, "openrouter-grok", "alphabetical tie-break, unchanged");
});

test("hdl-or-04: an explicit priority wins over an unset sibling of the same provider", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("openrouter-kimi", "openrouter", 0), lane("openrouter-grok", "openrouter")];
  const picked = select(strategy, "build", candidates);
  assert.equal(picked?.lane_id, "openrouter-kimi");
});

test("hdl-or-04: between two lanes with explicit priorities, the lower numeric value wins", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("openrouter-grok", "openrouter", 2), lane("openrouter-kimi", "openrouter", 1)];
  const picked = select(strategy, "build", candidates);
  assert.equal(picked?.lane_id, "openrouter-kimi");
});

test("hdl-or-04: equal explicit priorities fall back to lane_id tie-break", () => {
  const strategy = new PriorityStrategy();
  const candidates = [lane("openrouter-grok", "openrouter", 1), lane("openrouter-kimi", "openrouter", 1)];
  const picked = select(strategy, "build", candidates);
  assert.equal(picked?.lane_id, "openrouter-grok", "alphabetical tie-break on equal explicit priority");
});

test("hdl-or-04: an explicit priority can outrank a table-listed provider (documented cross-scale comparison)", () => {
  const strategy = new PriorityStrategy();
  // codex is rank 0 for "build"; an openrouter lane with explicit priority 0 ties it and wins alphabetically.
  const candidates = [lane("codex", "codex"), lane("aaa-openrouter", "openrouter", 0)];
  const picked = select(strategy, "build", candidates);
  assert.equal(picked?.lane_id, "aaa-openrouter");
});
