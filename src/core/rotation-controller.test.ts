import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvCredentialSource } from "./credential-source.js";
import { LaneRegistry } from "./lane-registry.js";
import { StateStore } from "./state-store.js";
import { parseClaudeCapSignal } from "./error-parser.js";
import { createCapResetRecoveryJob, startCapResetRecoveryJob } from "./background-jobs.js";
import { NoHealthyAccountsAvailableError, RotationController } from "./rotation-controller.js";

function registry(): LaneRegistry {
  return new LaneRegistry(
    [
      {
        lane_id: "claude-a",
        provider: "claude",
        model: "claude-sonnet",
        credential_ref: "CLAUDE_A_TOKEN",
      },
      {
        lane_id: "claude-b",
        provider: "claude",
        model: "claude-sonnet",
        credential_ref: "CLAUDE_B_TOKEN",
      },
    ],
    new EnvCredentialSource({
      CLAUDE_A_TOKEN: "token-a",
      CLAUDE_B_TOKEN: "token-b",
    }),
  );
}

function markUp(store: StateStore, lane_id: string, observed_at = "2026-08-08T12:00:00.000Z"): void {
  store.recordStatus({
    lane_id,
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at,
  });
}

test("parses Claude 429 weekly-limit responses with reset windows", () => {
  const signal = parseClaudeCapSignal(
    {
      status: 429,
      body: {
        error: {
          message: "weekly limit reached",
          reset_at: "2026-08-15T12:00:00.000Z",
        },
      },
    },
    new Date("2026-08-08T12:00:00.000Z"),
  );

  assert.deepEqual(signal, {
    kind: "weekly_limit",
    reset_at: "2026-08-15T12:00:00.000Z",
    reason: "weekly limit reached",
  });
});

test("parses OAuth-expired Claude SDK errors as capped signals", () => {
  const signal = parseClaudeCapSignal(
    {
      statusCode: 401,
      message: "OAuth token expired",
    },
    new Date("2026-08-08T12:00:00.000Z"),
  );

  assert.equal(signal?.kind, "oauth_expired");
  assert.equal(signal?.reset_at, "2026-08-15T12:00:00.000Z");
});

test("429 weekly-limit response caps current account and rotates to the next healthy account", async () => {
  const store = new StateStore(":memory:");
  markUp(store, "claude-a");
  markUp(store, "claude-b");
  const controller = new RotationController(registry(), store, {
    activeLaneId: "claude-a",
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  });

  const seenTokens: string[] = [];
  await controller.request(async (account) => {
    seenTokens.push(account.token);
    if (account.lane_id === "claude-a") {
      return {
        status: 429,
        body: { error: { message: "weekly limit reached", reset_at: "2026-08-15T12:00:00.000Z" } },
      };
    }
    return { status: 200, body: { ok: true } };
  });

  assert.deepEqual(seenTokens, ["token-a", "token-b"]);
  assert.equal(store.getCurrentStatus("claude-a")?.status, "out_of_credit");
  assert.equal(store.getCurrentStatus("claude-a")?.reset_at, "2026-08-15T12:00:00.000Z");
  assert.equal(controller.getActiveAccount().lane_id, "claude-b");

  // hdl-ot-02: both the cap and the rotation get a local telemetry record —
  // previously this whole flow emitted nothing locally at all.
  const events = store.getTelemetryEventCounts("rotation_event");
  const kinds = events.flatMap((e) => Array(e.count).fill(e.labels.kind));
  assert.ok(kinds.includes("capped"));
  assert.ok(kinds.includes("rotated"));
  store.close();
});

test("request fails clearly when all accounts are capped", async () => {
  const store = new StateStore(":memory:");
  markUp(store, "claude-a");
  markUp(store, "claude-b");
  const controller = new RotationController(registry(), store, {
    activeLaneId: "claude-a",
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  });

  await assert.rejects(
    () =>
      controller.request(async () => ({
        status: 429,
        body: { error: { message: "weekly limit reached" } },
      })),
    (error: unknown) =>
      error instanceof NoHealthyAccountsAvailableError &&
      error.message === "no healthy accounts available",
  );
  store.close();
});

test("background reset recovery restores capped accounts whose reset_at is in the past", () => {
  const store = new StateStore(":memory:");
  markUp(store, "claude-a", "2026-08-08T11:00:00.000Z");
  markUp(store, "claude-b", "2026-08-08T11:00:00.000Z");
  const controller = new RotationController(registry(), store, {
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  });
  controller.markCapped("claude-a", {
    kind: "weekly_limit",
    reset_at: "2026-08-08T11:59:00.000Z",
    reason: "weekly limit reached",
  });
  controller.markCapped("claude-b", {
    kind: "weekly_limit",
    reset_at: "2026-08-08T12:30:00.000Z",
    reason: "weekly limit reached",
  });

  const job = createCapResetRecoveryJob(controller);
  assert.equal(job.name, "cap-reset-recovery");
  assert.deepEqual(job.run(), ["claude-a"]);
  assert.equal(store.getCurrentStatus("claude-a")?.status, "up");
  assert.equal(store.getCurrentStatus("claude-b")?.status, "out_of_credit");
  store.close();
});

test("cap reset recovery can run as a periodic job without starting implicitly", () => {
  const store = new StateStore(":memory:");
  markUp(store, "claude-a", "2026-08-08T11:00:00.000Z");
  const controller = new RotationController(registry(), store, {
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  });
  controller.markCapped("claude-a", {
    kind: "weekly_limit",
    reset_at: "2026-08-08T11:59:00.000Z",
    reason: "weekly limit reached",
  });

  const job = startCapResetRecoveryJob(controller, { intervalMs: 5 * 60 * 1000 });
  try {
    assert.deepEqual(job.run(), ["claude-a"]);
  } finally {
    job.stop();
    store.close();
  }
});
