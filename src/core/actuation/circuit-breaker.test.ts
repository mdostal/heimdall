import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "./circuit-breaker.js";

test("starts closed — calls go through normally", async () => {
  const breaker = new CircuitBreaker();
  const outcome = await breaker.call(async () => "ok", () => true);
  assert.equal(outcome.circuitOpen, false);
  assert.equal(breaker.getState(), "closed");
});

test("opens after the failure threshold is reached", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3 });
  for (let i = 0; i < 3; i++) {
    await breaker.call(async () => "fail", () => false);
  }
  assert.equal(breaker.getState(), "open");
});

test("does not open before the failure threshold is reached", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3 });
  await breaker.call(async () => "fail", () => false);
  await breaker.call(async () => "fail", () => false);
  assert.equal(breaker.getState(), "closed");
});

test("while open, calls short-circuit immediately without invoking fn", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  await breaker.call(async () => "fail", () => false); // opens the circuit

  let fnCalled = false;
  const outcome = await breaker.call(async () => {
    fnCalled = true;
    return "should not run";
  }, () => true);

  assert.equal(outcome.circuitOpen, true);
  assert.equal(fnCalled, false);
});

test("a successful call resets consecutive failures and closes the circuit", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3 });
  await breaker.call(async () => "fail", () => false);
  await breaker.call(async () => "fail", () => false);
  await breaker.call(async () => "ok", () => true); // resets
  await breaker.call(async () => "fail", () => false);
  await breaker.call(async () => "fail", () => false);
  assert.equal(breaker.getState(), "closed", "two failures after a reset should not reopen a threshold-3 breaker");
});

test("transitions to half-open after the cooldown window elapses, allowing one trial call", async () => {
  let now = 1_000_000;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: () => now });

  await breaker.call(async () => "fail", () => false); // opens
  assert.equal(breaker.getState(), "open");

  now += 15_000; // still within cooldown
  assert.equal(breaker.getState(), "open");

  now += 20_000; // cooldown elapsed (35s total)
  assert.equal(breaker.getState(), "half-open");

  let fnCalled = false;
  const outcome = await breaker.call(async () => {
    fnCalled = true;
    return "trial";
  }, () => true);
  assert.equal(fnCalled, true, "half-open must allow exactly one trial call through");
  assert.equal(outcome.circuitOpen, false);
});

test("a successful half-open trial call closes the circuit", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: () => now });
  await breaker.call(async () => "fail", () => false);
  now = 2_000;
  await breaker.call(async () => "ok", () => true);
  assert.equal(breaker.getState(), "closed");
});

test("a failed half-open trial call re-opens the circuit", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: () => now });
  await breaker.call(async () => "fail", () => false);
  now = 2_000;
  await breaker.call(async () => "still failing", () => false);
  assert.equal(breaker.getState(), "open");

  now = 2_500; // still within the NEW cooldown window (reopened at now=2000)
  assert.equal(breaker.getState(), "open");
});
