import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteOutcomeTracker, routeOutcomeToPassiveResponse } from "./route-outcome.js";
import { observePassiveSignal } from "./passive.js";

const NOW = new Date("2026-09-27T12:00:00.000Z");

function rateLimitError(message = "This request would exceed the rate limit for your organization.") {
  return { status: 429, body: { type: "error", error: { type: "rate_limit_error", message } } };
}

test("heimdall#96: a success outcome is passive evidence of up", () => {
  const response = routeOutcomeToPassiveResponse({ outcome: "success", metadata: null }, NOW);
  assert.deepEqual(observePassiveSignal(response), { status: "up", reset_at: null, reason: null, error_code: null });
});

test("heimdall#96: a failure outcome with a rate-limit error classifies as down with rate_limit and a reset_at", () => {
  const response = routeOutcomeToPassiveResponse({ outcome: "failure", metadata: { error: rateLimitError() } }, NOW);
  const signal = observePassiveSignal(response);
  assert.equal(signal?.status, "down");
  assert.equal(signal?.error_code, "rate_limit");
  assert.ok(signal?.reset_at, "error-parser's reset_at must come through");
});

test("heimdall#96: a failure outcome with a weekly-limit error classifies as out_of_credit / quota_exceeded", () => {
  const response = routeOutcomeToPassiveResponse(
    { outcome: "failed", metadata: { error: rateLimitError("Your weekly limit has been reached.") } },
    NOW,
  );
  const signal = observePassiveSignal(response);
  assert.equal(signal?.status, "out_of_credit");
  assert.equal(signal?.error_code, "quota_exceeded");
});

test("heimdall#96: a failure error-parser can't classify, or a missing error, yields no signal", () => {
  assert.equal(
    routeOutcomeToPassiveResponse({ outcome: "failure", metadata: { error: { status: 400, message: "bad prompt" } } }, NOW),
    null,
  );
  assert.equal(routeOutcomeToPassiveResponse({ outcome: "failure", metadata: null }, NOW), null);
});

test("heimdall#96: an unrecognized or absent outcome label yields no signal", () => {
  assert.equal(routeOutcomeToPassiveResponse({ outcome: "partial", metadata: { error: rateLimitError() } }, NOW), null);
  assert.equal(routeOutcomeToPassiveResponse({ outcome: null, metadata: null }, NOW), null);
});

test("heimdall#96: RouteOutcomeTracker keeps the most recent outcome per lane and hands it out only once", () => {
  const tracker = new RouteOutcomeTracker();
  tracker.record("lane-a", { ok: false, classifiedStatus: "down" });
  tracker.record("lane-a", { ok: true, classifiedStatus: "up" });
  tracker.record("lane-b", { ok: false, classifiedStatus: "out_of_credit" });

  assert.equal(tracker.take("lane-a")?.classifiedStatus, "up");
  assert.equal(tracker.take("lane-a"), null, "a consumed outcome must not corroborate itself on the next refresh");
  assert.equal(tracker.take("lane-b")?.classifiedStatus, "out_of_credit");
});
