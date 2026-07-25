import { test } from "node:test";
import assert from "node:assert/strict";
import { observePassiveSignal } from "./passive.js";

test("returns null (no signal) when there's nothing to observe", () => {
  assert.equal(observePassiveSignal(null), null);
});

test("a successful response resolves to up", () => {
  const signal = observePassiveSignal({ ok: true, statusCode: 200 });
  assert.deepEqual(signal, { status: "up", reset_at: null, reason: null });
});

test("a billing_error resolves to out_of_credit, carrying reset_at when present", () => {
  const signal = observePassiveSignal({
    ok: false,
    errorType: "billing_error",
    resetAt: "2026-08-01T00:00:00.000Z",
    message: "payment required",
  });
  assert.equal(signal?.status, "out_of_credit");
  assert.equal(signal?.reset_at, "2026-08-01T00:00:00.000Z");
  assert.equal(signal?.reason, "payment required");
});

test("a rate_limit_error resolves to degraded", () => {
  const signal = observePassiveSignal({
    ok: false,
    errorType: "rate_limit_error",
    resetAt: "2026-07-25T12:05:00.000Z",
  });
  assert.equal(signal?.status, "degraded");
  assert.equal(signal?.reset_at, "2026-07-25T12:05:00.000Z");
});

test("a 5xx response resolves to down", () => {
  const signal = observePassiveSignal({ ok: false, statusCode: 503 });
  assert.equal(signal?.status, "down");
  assert.match(signal?.reason ?? "", /503/);
});

test("an unrecognized error falls back to degraded rather than throwing", () => {
  const signal = observePassiveSignal({ ok: false, message: "something odd" });
  assert.equal(signal?.status, "degraded");
  assert.equal(signal?.reason, "something odd");
});

test("is provider-agnostic — no Claude/Codex-specific branching (structural check)", () => {
  const src = observePassiveSignal.toString();
  assert.ok(!/claude|codex|anthropic|openai/i.test(src), "passive.ts must stay provider-agnostic");
});
