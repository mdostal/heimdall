import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvCredentialSource } from "./credential-source.js";

test("resolves a credential_ref to its env var value", () => {
  const source = new EnvCredentialSource({ CLAUDE_TOKEN: "sk-ant-abc123" });
  assert.equal(source.resolve("CLAUDE_TOKEN"), "sk-ant-abc123");
});

test("returns null for a missing credential_ref (REQ-07: no crash)", () => {
  const source = new EnvCredentialSource({});
  assert.equal(source.resolve("DOES_NOT_EXIST"), null);
});

test("returns null for an empty-string env var (treated as invalid)", () => {
  const source = new EnvCredentialSource({ EMPTY_TOKEN: "" });
  assert.equal(source.resolve("EMPTY_TOKEN"), null);
});
