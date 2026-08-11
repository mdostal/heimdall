import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLaneDeclarations, LaneRegistry } from "./lane-registry.js";
import { EnvCredentialSource } from "./credential-source.js";

function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("loadLaneDeclarations reads contiguous HEIMDALL_LANE_N_* triples", () => {
  const env = {
    HEIMDALL_LANE_1_ID: "claude@mathew.dostal",
    HEIMDALL_LANE_1_PROVIDER: "claude",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
    HEIMDALL_LANE_1_HEADROOM: "2500",
    HEIMDALL_LANE_1_COST_TIER: "low",
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
    headroom: 2500,
    cost_tier: "low",
  });
});

test("loadLaneDeclarations skips invalid headroom metadata without stopping later lanes", () => {
  for (const invalidHeadroom of ["abc", "-1", "Infinity"]) {
    const { result: declarations, warnings } = captureWarnings(() =>
      loadLaneDeclarations({
        HEIMDALL_LANE_1_ID: `bad-${invalidHeadroom}`,
        HEIMDALL_LANE_1_PROVIDER: "codex",
        HEIMDALL_LANE_1_CREDENTIAL_REF: "CODEX_TOKEN",
        HEIMDALL_LANE_1_HEADROOM: invalidHeadroom,
        HEIMDALL_LANE_2_ID: "claude",
        HEIMDALL_LANE_2_PROVIDER: "claude",
        HEIMDALL_LANE_2_CREDENTIAL_REF: "CLAUDE_TOKEN",
      }),
    );

    assert.deepEqual(
      declarations.map((lane) => lane.lane_id),
      ["claude"],
    );
    assert.match(warnings[0], /HEIMDALL_LANE_1_HEADROOM must be a finite non-negative number/);
  }
});

test("loadLaneDeclarations skips invalid cost tier metadata", () => {
  const { result: declarations, warnings } = captureWarnings(() =>
    loadLaneDeclarations({
      HEIMDALL_LANE_1_ID: "codex",
      HEIMDALL_LANE_1_PROVIDER: "codex",
      HEIMDALL_LANE_1_CREDENTIAL_REF: "CODEX_TOKEN",
      HEIMDALL_LANE_1_COST_TIER: "premium",
      HEIMDALL_LANE_2_ID: "claude",
      HEIMDALL_LANE_2_PROVIDER: "claude",
      HEIMDALL_LANE_2_CREDENTIAL_REF: "CLAUDE_TOKEN",
    }),
  );

  assert.deepEqual(
    declarations.map((lane) => lane.lane_id),
    ["claude"],
  );
  assert.match(warnings[0], /HEIMDALL_LANE_1_COST_TIER must be one of low\|medium\|high/);
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
  assert.equal(lane?.headroom, 10000);
  assert.equal(lane?.cost_tier, "medium");
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
