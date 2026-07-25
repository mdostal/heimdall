import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStatus } from "./status-model.js";

test("resolves each of the 4 valid status values", () => {
  for (const status of ["up", "down", "out_of_credit", "degraded"] as const) {
    const result = resolveStatus({ status });
    assert.equal(result.status, status);
  }
});

test("carries reset_at through when present and out_of_credit", () => {
  const result = resolveStatus({ status: "out_of_credit", reset_at: "2026-08-01T00:00:00.000Z" });
  assert.equal(result.status, "out_of_credit");
  assert.equal(result.reset_at, "2026-08-01T00:00:00.000Z");
});

test("reset_at defaults to null when absent", () => {
  const result = resolveStatus({ status: "up" });
  assert.equal(result.reset_at, null);
});

test("reason passes through when present", () => {
  const result = resolveStatus({ status: "degraded", reason: "elevated latency" });
  assert.equal(result.reason, "elevated latency");
});

test("null input resolves to degraded, not a throw", () => {
  const result = resolveStatus(null);
  assert.equal(result.status, "degraded");
  assert.equal(result.reason, "malformed signal input");
});

test("undefined input resolves to degraded, not a throw", () => {
  const result = resolveStatus(undefined);
  assert.equal(result.status, "degraded");
});

test("a non-object input resolves to degraded, not a throw", () => {
  // @ts-expect-error — deliberately passing a malformed shape to test the runtime guard
  const result = resolveStatus("not an object");
  assert.equal(result.status, "degraded");
});

test("an unrecognized status string resolves to degraded with a descriptive reason", () => {
  const result = resolveStatus({ status: "on_fire" });
  assert.equal(result.status, "degraded");
  assert.match(result.reason ?? "", /on_fire/);
});

test("a non-string reset_at is dropped to null rather than passed through", () => {
  // @ts-expect-error — deliberately passing a malformed shape to test the runtime guard
  const result = resolveStatus({ status: "up", reset_at: 12345 });
  assert.equal(result.reset_at, null);
});
