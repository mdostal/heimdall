import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCredentialSource,
  EnvCredentialSource,
  localStopgapEnvName,
  PortunusCredentialSource,
} from "./credential-source.js";

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

test("supports explicit env: credential refs", () => {
  const source = new EnvCredentialSource({ CLAUDE_TOKEN: "sk-ant-abc123" });
  assert.equal(source.resolve("env:CLAUDE_TOKEN"), "sk-ant-abc123");
});

test("PortunusCredentialSource resolves a portunus ref through the CLI temp-file boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-portunus-"));
  const secretFile = join(dir, "resolved");
  writeFileSync(secretFile, "sk-brokered-secret", { mode: 0o600 });

  let commandSeen = "";
  let argsSeen: readonly string[] = [];
  const execMock = ((command: string, args: readonly string[]) => {
    commandSeen = command;
    argsSeen = args;
    return `${secretFile}\n`;
  }) as typeof execFileSync;

  try {
    const source = new PortunusCredentialSource(
      { PORTUNUS_BIN: "portunus-test" },
      { execFileSync: execMock },
    );

    assert.equal(source.resolve("portunus:shared-anthropic"), "sk-brokered-secret");
    assert.equal(commandSeen, "portunus-test");
    assert.deepEqual(argsSeen, ["resolve", "{{secret:shared-anthropic}}"]);
    assert.equal(existsSync(secretFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PortunusCredentialSource returns null for non-portunus refs", () => {
  const source = new PortunusCredentialSource(
    {},
    {
      execFileSync: (() => {
        throw new Error("should not execute");
      }) as typeof execFileSync,
    },
  );
  assert.equal(source.resolve("CLAUDE_TOKEN"), null);
});

test("buildCredentialSource falls back to documented local env stopgap when Portunus is absent", () => {
  const source = buildCredentialSource(
    {
      HEIMDALL_SECRET_BROKER: "portunus",
      [localStopgapEnvName("shared-anthropic")]: "sk-local-stopgap",
    },
    {
      execFileSync: (() => {
        throw Object.assign(new Error("spawn portunus ENOENT"), { code: "ENOENT" });
      }) as typeof execFileSync,
    },
  );

  assert.equal(source.resolve("portunus:shared-anthropic"), "sk-local-stopgap");
});
