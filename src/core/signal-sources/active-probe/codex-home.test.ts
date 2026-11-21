import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexHomeStore, defaultCodexHomeRoot } from "./codex-home.js";

function withTempRoot(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "heimdall-codex-home-"));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("seeds auth.json (mode 600) into a per-seed home on first use", withTempRoot(async (root) => {
  const store = new CodexHomeStore(root);
  const home = await store.withHome('{"seed":1}', async ({ home, workdir }) => {
    assert.ok(workdir.startsWith(home + path.sep));
    return home;
  });
  const authPath = path.join(home, "auth.json");
  assert.equal(readFileSync(authPath, "utf8"), '{"seed":1}');
  assert.equal(statSync(authPath).mode & 0o777, 0o600);
}));

test("never overwrites auth.json once the CLI owns it — a rotated refresh token must survive the next probe", withTempRoot(async (root) => {
  const store = new CodexHomeStore(root);
  const home = await store.withHome('{"seed":1}', async ({ home }) => home);
  writeFileSync(path.join(home, "auth.json"), '{"rotated":true}');
  await store.withHome('{"seed":1}', async () => undefined);
  assert.equal(readFileSync(path.join(home, "auth.json"), "utf8"), '{"rotated":true}');
}));

test("a different seed (a fresh login) gets its own home", withTempRoot(async (root) => {
  const store = new CodexHomeStore(root);
  const a = await store.withHome('{"seed":1}', async ({ home }) => home);
  const b = await store.withHome('{"seed":2}', async ({ home }) => home);
  assert.notEqual(a, b);
}));

test("calls on the same home run one at a time, even when one fails", withTempRoot(async (root) => {
  const store = new CodexHomeStore(root);
  let active = 0;
  let maxActive = 0;
  const probe = (fail: boolean) =>
    store.withHome('{"seed":1}', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      if (fail) throw new Error("boom");
    });
  const results = await Promise.allSettled([probe(true), probe(false), probe(false)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled", "fulfilled"]);
}));

test("the root defaults to $HEIMDALL_HOME/codex; HEIMDALL_CODEX_HOME_ROOT overrides it", () => {
  assert.equal(defaultCodexHomeRoot({ HEIMDALL_CODEX_HOME_ROOT: "/var/lib/heimdall/codex" }), "/var/lib/heimdall/codex");
  assert.equal(defaultCodexHomeRoot({ HEIMDALL_HOME: "/srv/heimdall" }), "/srv/heimdall/codex");
  assert.equal(defaultCodexHomeRoot({}), path.join(os.homedir(), ".heimdall", "codex"));
});
