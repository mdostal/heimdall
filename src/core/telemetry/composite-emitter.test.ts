import { test } from "node:test";
import assert from "node:assert/strict";
import { CompositeTelemetryEmitter } from "./composite-emitter.js";
import type { ArgusEmitter } from "./argus-client.js";

function fakeEmitter(calls: string[], name: string, opts: { throwOn?: string } = {}): ArgusEmitter {
  const record = (method: string) => {
    if (opts.throwOn === method) throw new Error(`${name} failed on ${method}`);
    calls.push(`${name}:${method}`);
  };
  return {
    emitTick: () => record("emitTick"),
    emitStatusFlip: () => record("emitStatusFlip"),
    emitActuationResult: () => record("emitActuationResult"),
  };
}

test("hdl-ot-01: CompositeTelemetryEmitter fans every call out to every emitter", () => {
  const calls: string[] = [];
  const composite = new CompositeTelemetryEmitter([fakeEmitter(calls, "local"), fakeEmitter(calls, "argus")]);

  composite.emitStatusFlip({ laneId: "l", provider: "p", from: "up", to: "down" });

  assert.deepEqual(calls.sort(), ["argus:emitStatusFlip", "local:emitStatusFlip"]);
});

test("hdl-ot-01: one emitter throwing does not stop the others or propagate to the caller", () => {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const composite = new CompositeTelemetryEmitter(
    [fakeEmitter(calls, "local", { throwOn: "emitActuationResult" }), fakeEmitter(calls, "argus")],
    (err) => errors.push(err),
  );

  assert.doesNotThrow(() =>
    composite.emitActuationResult({
      laneId: "l",
      provider: "p",
      agentId: "a",
      action: "disable",
      success: true,
    }),
  );

  assert.deepEqual(calls, ["argus:emitActuationResult"]);
  assert.equal(errors.length, 1);
});
