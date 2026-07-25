import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MulticaAutopilotScheduler,
  validateCronExpression,
  autopilotTitleFor,
} from "./multica-autopilot-scheduler.js";
import type { CommandRunner } from "./command-runner.js";
import type { Lane } from "../lane-registry.js";
import type { ArgusEmitter } from "../telemetry/argus-client.js";

const LANE: Lane = {
  lane_id: "claude@mathew.dostal",
  provider: "claude",
  credential_ref: "CLAUDE_TOKEN",
  credential: "fake",
};

function fakeArgus(): ArgusEmitter & { ticks: unknown[] } {
  const ticks: unknown[] = [];
  return { ticks, emitTick: (p) => ticks.push(p), emitStatusFlip: () => {} };
}

function recordingRunner(
  responses: Record<string, string>,
): CommandRunner & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run: async (command: string, args: string[]) => {
      calls.push({ command, args });
      const verb = args[0] === "autopilot" ? args[1] : args[0];
      const stdout = responses[verb] ?? "{}";
      return { stdout, stderr: "" };
    },
  };
}

test("validateCronExpression accepts standard 5-field cron", () => {
  assert.doesNotThrow(() => validateCronExpression("*/1 * * * *"));
  assert.doesNotThrow(() => validateCronExpression("0 * * * *"));
});

test("validateCronExpression rejects a 6-field (seconds) cron — violates the 1-min floor", () => {
  assert.throws(() => validateCronExpression("*/30 * * * * *"), /1-minute|cron floor|6 fields/i);
});

test("validateCronExpression rejects malformed field counts", () => {
  assert.throws(() => validateCronExpression("* * *"));
});

test("start() throws clearly when MULTICA_AUTOPILOT_AGENT is not configured", () => {
  const scheduler = new MulticaAutopilotScheduler({
    lane: LANE,
    cron: "*/1 * * * *",
    description: "test",
    agent: undefined,
    argus: fakeArgus(),
    commandRunner: recordingRunner({}),
  });
  assert.throws(() => scheduler.start(), /MULTICA_AUTOPILOT_AGENT/);
});

test("start() throws clearly on a cron floor violation, before shelling out", () => {
  const runner = recordingRunner({});
  const scheduler = new MulticaAutopilotScheduler({
    lane: LANE,
    cron: "*/30 * * * * *",
    description: "test",
    agent: "dostal-dev",
    argus: fakeArgus(),
    commandRunner: runner,
  });
  assert.throws(() => scheduler.start());
  assert.equal(runner.calls.length, 0, "must not shell out when cron validation fails");
});

test("registerNow(): creates a new autopilot + trigger when none exists yet", async () => {
  const runner = recordingRunner({
    list: JSON.stringify({ autopilots: [] }),
    create: JSON.stringify({ autopilot: { id: "new-id-123", title: autopilotTitleFor(LANE.lane_id) } }),
    get: JSON.stringify({ autopilot: { id: "new-id-123", title: "x" }, triggers: [] }),
    "trigger-add": "{}",
  });
  const argus = fakeArgus();
  const scheduler = new MulticaAutopilotScheduler({
    lane: LANE,
    cron: "*/1 * * * *",
    description: "run heimdall refresh",
    agent: "dostal-dev",
    argus,
    commandRunner: runner,
  });

  await scheduler.registerNow();

  const verbs = runner.calls.map((c) => c.args[1]);
  assert.deepEqual(verbs, ["list", "create", "get", "trigger-add"]);
  const createCall = runner.calls.find((c) => c.args[1] === "create")!;
  assert.ok(createCall.args.includes("--agent"));
  assert.ok(createCall.args.includes("dostal-dev"));
  assert.ok(createCall.args.includes("run_only"));
  const triggerCall = runner.calls.find((c) => c.args[1] === "trigger-add")!;
  assert.equal(triggerCall.args[2], "new-id-123");
  assert.equal(argus.ticks.length, 1);
});

test("registerNow(): reuses an existing autopilot by title, skips create", async () => {
  const title = autopilotTitleFor(LANE.lane_id);
  const runner = recordingRunner({
    list: JSON.stringify({ autopilots: [{ id: "existing-id-456", title }] }),
    get: JSON.stringify({ autopilot: { id: "existing-id-456", title }, triggers: [] }),
    "trigger-add": "{}",
  });
  const scheduler = new MulticaAutopilotScheduler({
    lane: LANE,
    cron: "*/1 * * * *",
    description: "run heimdall refresh",
    agent: "dostal-dev",
    argus: fakeArgus(),
    commandRunner: runner,
  });

  await scheduler.registerNow();

  const verbs = runner.calls.map((c) => c.args[1]);
  assert.deepEqual(verbs, ["list", "get", "trigger-add"], "must not call create when an autopilot with this title already exists");
});

test("registerNow(): fully idempotent — skips trigger-add when a schedule trigger already exists", async () => {
  const title = autopilotTitleFor(LANE.lane_id);
  const runner = recordingRunner({
    list: JSON.stringify({ autopilots: [{ id: "existing-id-789", title }] }),
    get: JSON.stringify({
      autopilot: { id: "existing-id-789", title },
      triggers: [{ kind: "schedule", cron: "*/1 * * * *" }],
    }),
  });
  const scheduler = new MulticaAutopilotScheduler({
    lane: LANE,
    cron: "*/1 * * * *",
    description: "run heimdall refresh",
    agent: "dostal-dev",
    argus: fakeArgus(),
    commandRunner: runner,
  });

  await scheduler.registerNow();

  const verbs = runner.calls.map((c) => c.args[1]);
  assert.deepEqual(verbs, ["list", "get"], "second start() call must be a no-op beyond checking state");
});

test("registerNow(): a CommandRunner failure is caught and logged, never thrown", async () => {
  const errors: unknown[] = [];
  const runner: CommandRunner = {
    run: async () => {
      throw new Error("multica: command not found");
    },
  };
  const scheduler = new MulticaAutopilotScheduler({
    lane: LANE,
    cron: "*/1 * * * *",
    description: "run heimdall refresh",
    agent: "dostal-dev",
    argus: fakeArgus(),
    commandRunner: runner,
    onRegistrationError: (err) => errors.push(err),
  });

  await assert.doesNotReject(() => scheduler.registerNow());
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /command not found/);
});

test("stop() does not delete the autopilot (no-op by design)", () => {
  const runner = recordingRunner({});
  const scheduler = new MulticaAutopilotScheduler({
    lane: LANE,
    cron: "*/1 * * * *",
    description: "run heimdall refresh",
    agent: "dostal-dev",
    argus: fakeArgus(),
    commandRunner: runner,
  });
  scheduler.stop();
  assert.equal(runner.calls.length, 0);
});
