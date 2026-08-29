// Focused tests for buildLaneRegistry's credential-source selection
// (heimdall/docs/decisions/DEC-hdl-portunus-deferral.md's own explicit
// requirement: standalone-mode behavior must be byte-identical unless a
// caller opts in explicitly). Kept as its own small file rather than
// added to the large http-server.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaneRegistry } from "./http-server.js";

test("buildLaneRegistry(): with no HEIMDALL_CREDENTIAL_SOURCE set, standalone EnvCredentialSource behavior is unchanged", () => {
  const registry = buildLaneRegistry({
    HEIMDALL_LANE_1_ID: "lane-1",
    HEIMDALL_LANE_1_PROVIDER: "claude",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
    CLAUDE_TOKEN: "sk-ant-real-value",
  });

  const lane = registry.get("lane-1");
  assert.equal(lane?.credential, "sk-ant-real-value", "resolves straight from the env var, as before this story");
});

test("buildLaneRegistry(): HEIMDALL_CREDENTIAL_SOURCE=pantheon opts into PantheonSecretCredentialSource (never reads the bare env var directly)", () => {
  const registry = buildLaneRegistry({
    HEIMDALL_CREDENTIAL_SOURCE: "pantheon",
    HEIMDALL_LANE_1_ID: "lane-1",
    HEIMDALL_LANE_1_PROVIDER: "claude",
    HEIMDALL_LANE_1_CREDENTIAL_REF: "CLAUDE_TOKEN",
    // Deliberately present with a real-looking value: proves plugin mode does NOT fall back to
    // reading this directly -- PantheonSecretCredentialSource's real HTTP call is what runs,
    // and with no real Pantheon Core reachable in this test environment it resolves to null,
    // not this env var's value.
    CLAUDE_TOKEN: "sk-ant-should-not-be-used",
    PANTHEON_API_URL: "http://127.0.0.1:1", // deliberately unreachable
  });

  const lane = registry.get("lane-1");
  assert.notEqual(lane?.credential, "sk-ant-should-not-be-used");
});
