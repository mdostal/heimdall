import { test } from "node:test";
import assert from "node:assert/strict";
import { runRouteCommand, runRouteOutcomeCommand } from "./route-command.js";
import { LaneRegistry } from "../core/lane-registry.js";
import { useRouteLedgerPath } from "../core/route-selector.js";
import { StateStore } from "../core/state-store.js";

// The scored strategy's ledger defaults to the real Heimdall DB under $HOME
// (heimdall#96); keep every decision these tests make in memory instead.
useRouteLedgerPath(":memory:");

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// Captures console output and turns process.exit into a throw, so usage
// errors are observable without ending the test process.
function capture(fn: () => void): { out: string[]; err: string[]; exitCode: number | undefined } {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  console.log = (msg: string) => out.push(msg);
  console.error = (msg: string) => err.push(msg);
  process.exit = ((code?: number) => {
    throw new ExitCalled(code);
  }) as typeof process.exit;
  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExitCalled)) throw e;
    exitCode = e.code;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { out, err, exitCode };
}

function withUpLane(fn: (registry: LaneRegistry, store: StateStore) => void): void {
  const registry = new LaneRegistry([{ lane_id: "codex-a", provider: "codex", credential_ref: "CODEX_A_TOKEN" }], {
    resolve: () => "secret",
  });
  const store = new StateStore(":memory:");
  store.recordStatus({
    lane_id: "codex-a",
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: "2026-09-27T12:00:00.000Z",
  });
  try {
    fn(registry, store);
  } finally {
    store.close();
  }
}

for (const args of [[], ["--task-type=build"], ["--task-id=t1"]]) {
  test(`route-command: missing required flags (${JSON.stringify(args)}) prints usage and exits 1`, () => {
    withUpLane((registry, store) => {
      const { err, exitCode } = capture(() => runRouteCommand(args, registry, store));
      assert.equal(exitCode, 1);
      assert.match(err.join("\n"), /^Usage: heimdall route/);
    });
  });
}

test("route-command: an invalid task type is rejected with exit 1", () => {
  withUpLane((registry, store) => {
    const { err, exitCode } = capture(() => runRouteCommand(["--task-type=deploy", "--task-id=t1"], registry, store));
    assert.equal(exitCode, 1);
    assert.deepEqual(err, ["Invalid task-type: deploy"]);
  });
});

test("route-command: space-separated flags route to the eligible lane in human-readable form", () => {
  withUpLane((registry, store) => {
    const { out, exitCode } = capture(() =>
      runRouteCommand(["--task-type", "build", "--task-id", "t1", "--estimated-cost", "0.5"], registry, store),
    );
    assert.equal(exitCode, undefined);
    assert.equal(out[0], "Chosen Lane: codex-a");
    assert.match(out[1], /^Rationale: /);
  });
});

test("route-command: --json prints only the chosen lane on stdout and the full result on stderr", () => {
  withUpLane((registry, store) => {
    const { out, err } = capture(() => runRouteCommand(["--task-type=review", "--task-id=t2", "--json"], registry, store));
    assert.deepEqual(out, ["codex-a"]);
    const result = JSON.parse(err.join("\n"));
    assert.equal(result.chosen_lane, "codex-a");
    assert.equal(typeof result.decision_id, "string");
  });
});

test("route-command: route-outcome without --decision-id prints usage and exits 1", () => {
  const { err, exitCode } = capture(() => runRouteOutcomeCommand(["--outcome=success"]));
  assert.equal(exitCode, 1);
  assert.match(err.join("\n"), /^Usage: heimdall route-outcome/);
});

test("route-command: route-outcome for an unknown decision exits 1 with the error", () => {
  const { err, exitCode } = capture(() => runRouteOutcomeCommand(["--decision-id", "nope", "--actual-cost", "1"]));
  assert.equal(exitCode, 1);
  assert.deepEqual(err, ["Failed to report outcome: unknown_decision"]);
});

test("route-command: route-outcome records against a decision the route command just made", () => {
  withUpLane((registry, store) => {
    const { err } = capture(() => runRouteCommand(["--task-type=build", "--task-id=t3", "--json"], registry, store));
    const decisionId = JSON.parse(err.join("\n")).decision_id as string;
    const { out, exitCode } = capture(() => runRouteOutcomeCommand([`--decision-id=${decisionId}`, "--outcome=success"]));
    assert.equal(exitCode, undefined);
    assert.deepEqual(out, [`Outcome recorded for decision ${decisionId}.`]);
  });
});
