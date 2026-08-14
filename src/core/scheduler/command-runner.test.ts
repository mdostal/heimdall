import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeCommandRunner } from "./command-runner.js";

test("run(command, args) with no third argument behaves exactly as before — inherits process.env unchanged", async () => {
  const runner = new NodeCommandRunner();
  const result = await runner.run("node", ["-e", "process.stdout.write(String(process.env.PATH !== undefined))"]);
  assert.equal(result.stdout, "true");
});

test("run(command, args, { env }) additively sets the given variable in the subprocess, alongside the inherited environment", async () => {
  const runner = new NodeCommandRunner();
  const result = await runner.run(
    "node",
    ["-e", "process.stdout.write(process.env.HDL_TEST_VAR + '|' + String(process.env.PATH !== undefined))"],
    { env: { HDL_TEST_VAR: "hello" } },
  );
  assert.equal(result.stdout, "hello|true");
});

test("passing an env override never mutates Heimdall's own process.env", async () => {
  const runner = new NodeCommandRunner();
  assert.equal(process.env.HDL_TEST_VAR_ISOLATION, undefined);
  await runner.run("node", ["-e", "process.exit(0)"], { env: { HDL_TEST_VAR_ISOLATION: "leaked" } });
  assert.equal(process.env.HDL_TEST_VAR_ISOLATION, undefined);
});
