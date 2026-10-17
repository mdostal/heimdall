import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLaneDeclarations, LaneRegistry } from "./lane-registry.js";
import { EnvCredentialSource, type CredentialResolution, type CredentialSource } from "./credential-source.js";

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

// PANT-932 (heimdall#116): a credential source that's unreachable at startup
// must not leave a lane unconfigured for the life of the process.

function flakySource(): { source: CredentialSource; setUp: (up: boolean) => void; calls: () => number } {
  let up = false;
  let calls = 0;
  return {
    source: {
      resolve: () => null,
      resolveDetailed: (ref: string): CredentialResolution => {
        calls++;
        if (!up) return { state: "unavailable", detail: "core-api unreachable" };
        return ref === "CLAUDE_TOKEN" ? { state: "resolved", value: "sk-ant-x" } : { state: "unconfigured" };
      },
    },
    setUp: (value) => {
      up = value;
    },
    calls: () => calls,
  };
}

const TWO_LANES = [
  { lane_id: "claude", provider: "claude", credential_ref: "CLAUDE_TOKEN" },
  { lane_id: "codex", provider: "codex", credential_ref: "CODEX_TOKEN" },
];

test("PANT-932: an unreachable credential source marks lanes credential_unavailable, not unconfigured", () => {
  const { source } = flakySource();
  const registry = new LaneRegistry(TWO_LANES, source);
  for (const lane of registry.list()) {
    assert.equal(lane.credential, null);
    assert.equal(lane.credential_state, "credential_unavailable");
    assert.equal(lane.credential_detail, "core-api unreachable");
  }
});

test("PANT-932: retryCredential() recovers the lane IN PLACE once the source is back, and marks a missing credential unconfigured", () => {
  let now = 0;
  const flaky = flakySource();
  const registry = new LaneRegistry(TWO_LANES, flaky.source, { nowMs: () => now });
  const claude = registry.get("claude")!;

  flaky.setUp(true);
  now = 1_000;
  assert.equal(registry.retryCredential("claude"), true);
  assert.equal(claude.credential, "sk-ant-x", "the same Lane object schedulers hold gains the credential");
  assert.equal(claude.credential_state, "resolved");
  assert.equal(claude.credential_detail, null);

  assert.equal(registry.retryCredential("codex"), false);
  assert.equal(registry.get("codex")!.credential_state, "unconfigured");

  const callsBefore = flaky.calls();
  registry.retryCredential("codex");
  registry.retryCredential("claude");
  assert.equal(flaky.calls(), callsBefore, "resolved and unconfigured lanes are never re-fetched");
});

test("PANT-932: retryCredential() backs off exponentially (1s, 2s, 4s ... capped at 30s) and never gives up", () => {
  let now = 0;
  const flaky = flakySource();
  const registry = new LaneRegistry([TWO_LANES[0]], flaky.source, { nowMs: () => now });
  assert.equal(flaky.calls(), 1);

  now = 999;
  registry.retryCredential("claude");
  assert.equal(flaky.calls(), 1, "still inside the first 1s backoff");

  const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
  now = 0;
  for (const [i, delay] of expectedDelays.entries()) {
    now += delay - 1;
    registry.retryCredential("claude");
    assert.equal(flaky.calls(), i + 1, `no attempt before the ${delay}ms backoff elapses`);
    now += 1;
    registry.retryCredential("claude");
    assert.equal(flaky.calls(), i + 2, `attempt once the ${delay}ms backoff elapses`);
  }

  flaky.setUp(true);
  now += 30_000;
  assert.equal(registry.retryCredential("claude"), true);
});

test("PANT-932: a source without resolveDetailed() keeps the old resolved/unconfigured behavior", () => {
  const registry = new LaneRegistry(TWO_LANES, new EnvCredentialSource({ CLAUDE_TOKEN: "sk-ant-x" }));
  assert.equal(registry.get("claude")!.credential_state, "resolved");
  assert.equal(registry.get("codex")!.credential_state, "unconfigured");
});
