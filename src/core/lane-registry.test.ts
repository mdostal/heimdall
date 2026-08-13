import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLaneDeclarations, LaneRegistry } from "./lane-registry.js";
import { EnvCredentialSource } from "./credential-source.js";

test("loadLaneDeclarations reads contiguous HEIMDALL_LANE_N_* triples", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_PROVIDER: "claude",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
    HEIMDALL_LANE_2_ID: "codex",
    HEIMDALL_LANE_2_PROVIDER: "codex",
    HEIMDALL_LANE_2_CREDENTIAL_REF: "CODEX_TOKEN",
  };
  const declarations = loadLaneDeclarations(env);
  assert.equal(declarations.length, 2);
  assert.deepEqual(declarations[0], {
    lane_id: "claude@mathew.dostal",
    provider: "claude",
    credential_ref: "CLAUDE_TOKEN",
  });
});

test("stops at the first gap in numbering", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_PROVIDER: "claude",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
    // no HEIMDALL_LANE_2_*
    HEIMDALL_LANE_3_ID: "codex",
    HEIMDALL_LANE_3_PROVIDER: "codex",
    HEIMDALL_LANE_3_CREDENTIAL_REF: "CODEX_TOKEN",
  };
  const declarations = loadLaneDeclarations(env);
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].lane_id, "claude@mathew.dostal");
});

test("skips a malformed declaration (missing provider) without crashing", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    // no HEIMDALL_LANE_1_PROVIDER
    HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
  };
  const declarations = loadLaneDeclarations(env);
  assert.equal(declarations.length, 0);
});

test("LaneRegistry resolves credentials for declared lanes", () => {
  const declarations = [
    { lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" },
  ];
  const registry = new LaneRegistry(
    declarations,
    new EnvCredentialSource({ CLAUDE_TOKEN: "secret" }),
  );
  const lane = registry.get("claude@mathew.dostal");
  assert.ok(lane);
  assert.equal(lane?.credential, "secret");
});

test("LaneRegistry reports null credential for missing/invalid ref (REQ-07: no crash)", () => {
  const declarations = [
    { lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "MISSING_TOKEN" },
  ];
  const registry = new LaneRegistry(declarations, new EnvCredentialSource({}));
  const lane = registry.get("claude@mathew.dostal");
  assert.ok(lane);
  assert.equal(lane?.credential, null);
});

test("LaneRegistry.get returns null for an undeclared lane", () => {
  const registry = new LaneRegistry([], new EnvCredentialSource({}));
  assert.equal(registry.get("unknown"), null);
});

test("hdl-or-04: loadLaneDeclarations parses a valid HEIMDALL_LANE_N_PRIORITY into priority", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "openrouter-kimi",
    HEIMDALL_LANE_1_PROVIDER: "openrouter",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "OPENROUTER_TOKEN",
    HEIMDALL_LANE_1_PRIORITY: "0",
  };
  const declarations = loadLaneDeclarations(env);
  assert.equal(declarations[0].priority, 0);
});

test("hdl-or-04: an invalid HEIMDALL_LANE_N_PRIORITY (non-integer, negative) falls back to unset, not a crash", () => {
  const nonInteger = loadLaneDeclarations({
    HEIMDALL_LANE_1_ID: "a",
    HEIMDALL_LANE_1_PROVIDER: "openrouter",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "T",
    HEIMDALL_LANE_1_PRIORITY: "not-a-number",
  });
  assert.equal(nonInteger[0].priority, undefined);

  const negative = loadLaneDeclarations({
    HEIMDALL_LANE_1_ID: "a",
    HEIMDALL_LANE_1_PROVIDER: "openrouter",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "T",
    HEIMDALL_LANE_1_PRIORITY: "-1",
  });
  assert.equal(negative[0].priority, undefined);

  const fractional = loadLaneDeclarations({
    HEIMDALL_LANE_1_ID: "a",
    HEIMDALL_LANE_1_PROVIDER: "openrouter",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "T",
    HEIMDALL_LANE_1_PRIORITY: "1.5",
  });
  assert.equal(fractional[0].priority, undefined);
});

test("hdl-or-04: a lane with no HEIMDALL_LANE_N_PRIORITY declared has no priority field at all", () => {
  const declarations = loadLaneDeclarations({
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_PROVIDER: "claude",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
  });
  assert.equal("priority" in declarations[0], false);
});
