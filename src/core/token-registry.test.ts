import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOKEN_REGISTRY_SCHEMA_VERSION,
  TokenRegistry,
  type TokenRegistryData,
} from "./token-registry.js";

async function registryPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "heimdall-token-registry-")), "token-registry.json");
}

test("initialize creates an empty registry file with a schema version", async () => {
  const path = await registryPath();
  const registry = new TokenRegistry(path);

  const initialized = await registry.initialize();
  const persisted = JSON.parse(await readFile(path, "utf8")) as TokenRegistryData;

  assert.deepEqual(initialized, {
    schema_version: TOKEN_REGISTRY_SCHEMA_VERSION,
    accounts: [],
    active_account_id: null,
    last_rotation_at: null,
  });
  assert.deepEqual(persisted, initialized);
});

test("multiple account entries round-trip with status and metadata", async () => {
  const path = await registryPath();
  const registry = new TokenRegistry(path);

  await registry.upsertAccount({
    id: "primary",
    token: "sk-ant-primary",
    status: "healthy",
    weekly_usage: 450_000,
    cap_limit: 500_000,
    metadata: { email: "primary@example.com", priority: 1 },
  });
  await registry.upsertAccount({
    id: "backup",
    token: "sk-ant-backup",
    status: "degraded",
    weekly_usage: 50_000,
    cap_limit: 500_000,
    metadata: { email: "backup@example.com" },
  });

  const accounts = await registry.listAccounts();

  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].status, "healthy");
  assert.deepEqual(accounts[0].metadata, { email: "primary@example.com", priority: 1 });
  assert.equal(accounts[1].status, "degraded");
  assert.deepEqual(accounts[1].metadata, { email: "backup@example.com" });
});

test("reset_at for a capped account persists across registry reload", async () => {
  const path = await registryPath();
  const resetAt = "2026-08-14T00:00:00Z";

  await new TokenRegistry(path).upsertAccount({
    id: "primary",
    token: "sk-ant-primary",
    status: "capped",
    weekly_usage: 500_000,
    cap_limit: 500_000,
    reset_at: resetAt,
  });

  const reloaded = await new TokenRegistry(path).getAccount("primary");
  assert.equal(reloaded?.status, "capped");
  assert.equal(reloaded?.reset_at, resetAt);
});

test("concurrent registry updates serialize through the file lock without data loss", async () => {
  const path = await registryPath();
  const registry = new TokenRegistry({ path, lockTimeoutMs: 10_000, retryIntervalMs: 5 });

  await registry.initialize();
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      new TokenRegistry({ path, lockTimeoutMs: 10_000, retryIntervalMs: 5 }).upsertAccount({
        id: `account-${index}`,
        token: `sk-ant-${index}`,
        status: index % 2 === 0 ? "healthy" : "capped",
        weekly_usage: index,
        cap_limit: 500_000,
        reset_at: index % 2 === 0 ? null : "2026-08-14T00:00:00Z",
        metadata: { index },
      }),
    ),
  );

  const accounts = await registry.listAccounts();
  assert.equal(accounts.length, 20);
  assert.deepEqual(
    accounts
      .map((account) => account.id)
      .sort((left, right) => Number(left.split("-")[1]) - Number(right.split("-")[1])),
    Array.from({ length: 20 }, (_, index) => `account-${index}`),
  );
});
