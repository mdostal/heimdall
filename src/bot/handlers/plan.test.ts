import { test } from "node:test";
import assert from "node:assert/strict";
import { MinervaRequestError, MinervaUnavailableError } from "../../adapters/minerva.js";
import { formatPlanStatus, handlePlanCommand, parsePlanCommand } from "./plan.js";

test("parsePlanCommand recognizes trigger commands", () => {
  assert.deepEqual(parsePlanCommand("trigger add SSO to billing"), {
    action: "trigger",
    idea: "add SSO to billing",
    targetRepo: undefined,
  });
});

test("parsePlanCommand extracts optional trigger target repo", () => {
  assert.deepEqual(parsePlanCommand("trigger --target-repo /repos/app add SSO"), {
    action: "trigger",
    idea: "add SSO",
    targetRepo: "/repos/app",
  });
  assert.deepEqual(parsePlanCommand("trigger --target-repo=/repos/app add SSO"), {
    action: "trigger",
    idea: "add SSO",
    targetRepo: "/repos/app",
  });
});

test("parsePlanCommand recognizes status commands", () => {
  assert.deepEqual(parsePlanCommand("status"), { action: "status", runId: undefined });
  assert.deepEqual(parsePlanCommand("status run-123"), { action: "status", runId: "run-123" });
});

test("handlePlanCommand starts Minerva plan execution for trigger commands", async () => {
  const calls: Array<{ idea: string; targetRepo?: string }> = [];
  const response = await handlePlanCommand(
    { text: "trigger --target-repo /repos/app add SSO" },
    {
      minerva: {
        triggerPlan: async (options) => {
          calls.push(options);
          return { runId: "run-123" };
        },
        queryPlanStatus: async () => ({ status: "none" }),
      },
    },
  );

  assert.deepEqual(calls, [{ idea: "add SSO", targetRepo: "/repos/app" }]);
  assert.deepEqual(response, {
    response_type: "in_channel",
    text: "Minerva plan started: `run-123`",
  });
});

test("handlePlanCommand returns active plan status", async () => {
  const calls: Array<string | undefined> = [];
  const response = await handlePlanCommand(
    { text: "status run-123" },
    {
      minerva: {
        triggerPlan: async () => ({ runId: "unused" }),
        queryPlanStatus: async (runId) => {
          calls.push(runId);
          return {
            runId,
            status: "waiting_on_human",
            metrics: { turns: 3, escalations: 1, driver: "spawn" },
          };
        },
      },
    },
  );

  assert.deepEqual(calls, ["run-123"]);
  assert.deepEqual(response, {
    response_type: "in_channel",
    text: "Minerva plan `run-123` is waiting on human.\nMetrics: 3 turns, 1 escalations, driver spawn",
  });
});

test("handlePlanCommand returns newest active status when no run id is supplied", async () => {
  const response = await handlePlanCommand(
    { text: "status" },
    {
      minerva: {
        triggerPlan: async () => ({ runId: "unused" }),
        queryPlanStatus: async () => ({ runId: "active", status: "in_progress" }),
      },
    },
  );

  assert.deepEqual(response, {
    response_type: "in_channel",
    text: "Minerva plan `active` is in progress.",
  });
});

test("handlePlanCommand reports no active plans", async () => {
  const response = await handlePlanCommand(
    { text: "status" },
    {
      minerva: {
        triggerPlan: async () => ({ runId: "unused" }),
        queryPlanStatus: async () => ({ status: "none" }),
      },
    },
  );

  assert.deepEqual(response, {
    response_type: "ephemeral",
    text: "No active Minerva plan runs found.",
  });
});

test("handlePlanCommand shows a graceful Slack error when Minerva is unavailable", async () => {
  const response = await handlePlanCommand(
    { text: "trigger add SSO" },
    {
      minerva: {
        triggerPlan: async () => {
          throw new MinervaUnavailableError("command not found");
        },
        queryPlanStatus: async () => ({ status: "none" }),
      },
    },
  );

  assert.deepEqual(response, {
    response_type: "ephemeral",
    text: "Minerva planning is unavailable right now. Try again after the planner recovers.",
  });
});

test("handlePlanCommand surfaces Minerva request errors without throwing", async () => {
  const response = await handlePlanCommand(
    { text: "status missing" },
    {
      minerva: {
        triggerPlan: async () => ({ runId: "unused" }),
        queryPlanStatus: async () => {
          throw new MinervaRequestError("NOT_FOUND", "No run found");
        },
      },
    },
  );

  assert.deepEqual(response, {
    response_type: "ephemeral",
    text: "Minerva could not process that plan command: No run found",
  });
});

test("formatPlanStatus handles completed plans without metrics", () => {
  assert.equal(
    formatPlanStatus({ runId: "run-123", status: "complete", metrics: null }),
    "Minerva plan `run-123` is complete.",
  );
});
