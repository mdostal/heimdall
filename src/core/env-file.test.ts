import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLane, highestLaneIndex, laneIdAlreadyDeclared, deriveCredentialRef } from "./env-file.js";

function tmpEnvPath(): string {
  return path.join(os.tmpdir(), `heimdall-env-file-test-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
}

test("deriveCredentialRef sanitizes lane_id into a TOKEN-suffixed env var name", () => {
  assert.equal(deriveCredentialRef("gemini@ops"), "GEMINI_OPS_TOKEN");
  assert.equal(deriveCredentialRef("claude@mathew.dostal"), "CLAUDE_MATHEW_DOSTAL_TOKEN");
  assert.equal(deriveCredentialRef("codex"), "CODEX_TOKEN");
  assert.equal(deriveCredentialRef("  weird--lane__id  "), "WEIRD_LANE_ID_TOKEN");
});

test("highestLaneIndex returns 0 for a file that does not exist yet", () => {
  assert.equal(highestLaneIndex(tmpEnvPath()), 0);
});

test("highestLaneIndex finds the highest declared HEIMDALL_LANE_<N>_ID, not just the first", () => {
  const envPath = tmpEnvPath();
  fs.writeFileSync(
    envPath,
    "HEIMDALL_LANE_1_ID=claude@mathew.dostal\nHEIMDALL_LANE_2_ID=codex\nHEIMDALL_LANE_3_ID=gemini\n",
  );
  try {
    assert.equal(highestLaneIndex(envPath), 3);
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("appendLane creates the file when it does not exist yet, starting at index 1", () => {
  const envPath = tmpEnvPath();
  try {
    const result = appendLane(envPath, {
      lane_id: "gemini@ops",
      provider: "gemini",
      model: "gemini-3-pro",
      credential_ref: "GEMINI_OPS_TOKEN",
      token: "secret-value",
    });
    assert.equal(result.index, 1);
    const content = fs.readFileSync(envPath, "utf8");
    assert.match(content, /HEIMDALL_LANE_1_ID=gemini@ops/);
    assert.match(content, /HEIMDALL_LANE_1_PROVIDER=gemini/);
    assert.match(content, /HEIMDALL_LANE_1_MODEL=gemini-3-pro/);
    assert.match(content, /HEIMDALL_LANE_1_CREDENTIAL_REF=GEMINI_OPS_TOKEN/);
    assert.match(content, /GEMINI_OPS_TOKEN=secret-value/);
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("appendLane appends the next index and never touches existing lines", () => {
  const envPath = tmpEnvPath();
  fs.writeFileSync(
    envPath,
    "HEIMDALL_LANE_1_ID=claude@mathew.dostal\nHEIMDALL_LANE_1_PROVIDER=claude\nHEIMDALL_LANE_1_MODEL=claude-sonnet\nHEIMDALL_LANE_1_CREDENTIAL_REF=CLAUDE_MATHEW_DOSTAL_TOKEN\nCLAUDE_MATHEW_DOSTAL_TOKEN=already-here\n",
  );
  try {
    const before = fs.readFileSync(envPath, "utf8");
    const result = appendLane(envPath, {
      lane_id: "codex",
      provider: "codex",
      model: "gpt-codex",
      credential_ref: "CODEX_TOKEN",
      token: "codex-secret",
    });
    assert.equal(result.index, 2);
    const after = fs.readFileSync(envPath, "utf8");
    assert.ok(after.startsWith(before), "existing content must be preserved verbatim, appended-to only");
    assert.match(after, /HEIMDALL_LANE_2_ID=codex/);
    assert.doesNotMatch(after, /HEIMDALL_LANE_2_ID=codex[\s\S]*HEIMDALL_LANE_2_ID=codex/, "must never duplicate the new block");
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("appendLane handles a file missing its trailing newline without corrupting the boundary line", () => {
  const envPath = tmpEnvPath();
  fs.writeFileSync(envPath, "HEIMDALL_LANE_1_ID=claude@mathew.dostal"); // no trailing newline
  try {
    appendLane(envPath, {
      lane_id: "codex",
      provider: "codex",
      model: "gpt-codex",
      credential_ref: "CODEX_TOKEN",
      token: "codex-secret",
    });
    const content = fs.readFileSync(envPath, "utf8");
    assert.match(content, /^HEIMDALL_LANE_1_ID=claude@mathew\.dostal$/m, "the pre-existing line must not be merged with the new block");
    assert.match(content, /^HEIMDALL_LANE_2_ID=codex$/m);
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("appendLane preserves pre-existing comments untouched", () => {
  const envPath = tmpEnvPath();
  fs.writeFileSync(envPath, "# a comment about lanes\nHEIMDALL_LANE_1_ID=claude@mathew.dostal\n");
  try {
    appendLane(envPath, {
      lane_id: "codex",
      provider: "codex",
      model: "gpt-codex",
      credential_ref: "CODEX_TOKEN",
      token: "codex-secret",
    });
    const content = fs.readFileSync(envPath, "utf8");
    assert.match(content, /^# a comment about lanes$/m);
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});

test("laneIdAlreadyDeclared returns false for a file that does not exist yet", () => {
  assert.equal(laneIdAlreadyDeclared(tmpEnvPath(), "codex"), false);
});

test("laneIdAlreadyDeclared detects an exact lane_id match, not a substring", () => {
  const envPath = tmpEnvPath();
  fs.writeFileSync(envPath, "HEIMDALL_LANE_1_ID=codex\n");
  try {
    assert.equal(laneIdAlreadyDeclared(envPath, "codex"), true);
    assert.equal(laneIdAlreadyDeclared(envPath, "codex-2"), false);
    assert.equal(laneIdAlreadyDeclared(envPath, "gemini"), false);
  } finally {
    fs.rmSync(envPath, { force: true });
  }
});
