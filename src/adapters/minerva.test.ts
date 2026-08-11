import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MinervaPlanClient,
  MinervaRequestError,
  MinervaUnavailableError,
  createSubprocessInvoker,
  type MinervaEnvelope,
} from "./minerva.js";

test("triggerPlan invokes Minerva startRun with the idea", async () => {
  const calls: MinervaEnvelope[] = [];
  const client = new MinervaPlanClient({
    invoke: async (envelope) => {
      calls.push(envelope);
      return { run_id: "run-123" };
    },
  });

  const result = await client.triggerPlan({ idea: "add SSO to billing" });

  assert.deepEqual(calls, [{ method: "startRun", params: { idea: "add SSO to billing" } }]);
  assert.deepEqual(result, { runId: "run-123" });
});

test("triggerPlan forwards a target_repo when provided", async () => {
  const calls: MinervaEnvelope[] = [];
  const client = new MinervaPlanClient({
    invoke: async (envelope) => {
      calls.push(envelope);
      return { run_id: "run-456" };
    },
  });

  await client.triggerPlan({ idea: "plan repo work", targetRepo: "/repos/example" });

  assert.deepEqual(calls, [
    {
      method: "startRun",
      params: { idea: "plan repo work", target_repo: "/repos/example" },
    },
  ]);
});

test("queryPlanStatus invokes getRunStatus for a specific run", async () => {
  const client = new MinervaPlanClient({
    invoke: async () => ({
      status: "waiting_on_human",
      metrics: { turns: 2, escalations: 1, driver: "spawn" },
    }),
  });

  assert.deepEqual(await client.queryPlanStatus("run-123"), {
    runId: "run-123",
    status: "waiting_on_human",
    metrics: { turns: 2, escalations: 1, driver: "spawn" },
  });
});

test("queryPlanStatus returns the newest active run when no run id is supplied", async () => {
  const client = new MinervaPlanClient({
    invoke: async (envelope) => {
      assert.equal(envelope.method, "listRuns");
      return {
        runs: [
          { run_id: "old-complete", status: "complete", created_at: "2026-08-01T00:00:00Z" },
          { run_id: "new-active", status: "in_progress", created_at: "2026-08-03T00:00:00Z" },
          { run_id: "old-active", status: "awaiting-consus", created_at: "2026-08-02T00:00:00Z" },
        ],
      };
    },
  });

  assert.deepEqual(await client.queryPlanStatus(), {
    runId: "new-active",
    status: "in_progress",
    createdAt: "2026-08-03T00:00:00Z",
  });
});

test("queryPlanStatus reports no active runs", async () => {
  const client = new MinervaPlanClient({
    invoke: async () => ({
      runs: [{ run_id: "done", status: "complete", created_at: "2026-08-03T00:00:00Z" }],
    }),
  });

  assert.deepEqual(await client.queryPlanStatus(), { status: "none" });
});

test("client raises a typed request error for Minerva ABI errors", async () => {
  const client = new MinervaPlanClient({
    invoke: async () => {
      throw new MinervaRequestError("NOT_FOUND", "No run found");
    },
  });

  await assert.rejects(
    () => client.queryPlanStatus("missing"),
    (err) =>
      err instanceof MinervaRequestError &&
      err.code === "NOT_FOUND" &&
      err.message === "No run found",
  );
});

test("createSubprocessInvoker sends JSON-over-stdio and parses result envelopes", async () => {
  const invoker = createSubprocessInvoker({
    command: process.execPath,
    args: [
      "-e",
      [
        "let input='';",
        "process.stdin.on('data', c => input += c);",
        "process.stdin.on('end', () => {",
        "  const req = JSON.parse(input);",
        "  process.stdout.write(JSON.stringify({result:{method:req.method}}));",
        "});",
      ].join(""),
    ],
  });

  assert.deepEqual(await invoker({ method: "capabilities" }), { method: "capabilities" });
});

test("createSubprocessInvoker maps malformed subprocess output to unavailable", async () => {
  const invoker = createSubprocessInvoker({
    command: process.execPath,
    args: ["-e", "process.stdout.write('not json')"],
  });

  await assert.rejects(
    () => invoker({ method: "capabilities" }),
    (err) => err instanceof MinervaUnavailableError && /invalid JSON/.test(err.message),
  );
});
