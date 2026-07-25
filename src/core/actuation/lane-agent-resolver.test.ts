import { test } from "node:test";
import assert from "node:assert/strict";
import { StaticLaneAgentResolver, loadStaticLaneAgentMappings } from "./lane-agent-resolver.js";

test("resolves comma-separated agent IDs for a mapped lane", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_MULTICA_AGENT_IDS: "agent-a, agent-b",
  };
  const resolver = new StaticLaneAgentResolver(env);
  assert.deepEqual(resolver.resolve("claude@mathew.dostal"), ["agent-a", "agent-b"]);
});

test("returns an empty array for an unmapped lane — not an error, not undefined", () => {
  const env = { HEIMDALL_LANE_1_ID: "claude@mathew.dostal" };
  const resolver = new StaticLaneAgentResolver(env);
  assert.deepEqual(resolver.resolve("claude@mathew.dostal"), []);
});

test("returns an empty array for a lane_id that was never declared at all", () => {
  const resolver = new StaticLaneAgentResolver({});
  assert.deepEqual(resolver.resolve("never-declared"), []);
});

test("handles multiple declared lanes independently", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_MULTICA_AGENT_IDS: "agent-a",
    HEIMDALL_LANE_2_ID: "codex",
    // lane 2 intentionally unmapped
  };
  const resolver = new StaticLaneAgentResolver(env);
  assert.deepEqual(resolver.resolve("claude@mathew.dostal"), ["agent-a"]);
  assert.deepEqual(resolver.resolve("codex"), []);
});

test("stops at the first gap in HEIMDALL_LANE_<N>_ID numbering (matches lane-registry.ts convention)", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_MULTICA_AGENT_IDS: "agent-a",
    // no HEIMDALL_LANE_2_*
    HEIMDALL_LANE_3_ID: "codex",
    HEIMDALL_LANE_3_MULTICA_AGENT_IDS: "agent-c",
  };
  const mappings = loadStaticLaneAgentMappings(env);
  assert.equal(mappings.size, 1);
  assert.deepEqual(mappings.get("claude@mathew.dostal"), ["agent-a"]);
  assert.equal(mappings.has("codex"), false);
});

test("an empty MULTICA_AGENT_IDS value is treated as unmapped, not a single empty-string agent", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_MULTICA_AGENT_IDS: "",
  };
  const resolver = new StaticLaneAgentResolver(env);
  assert.deepEqual(resolver.resolve("claude@mathew.dostal"), []);
});
