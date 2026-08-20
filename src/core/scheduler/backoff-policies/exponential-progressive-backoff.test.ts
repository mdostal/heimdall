import { test } from "node:test";
import assert from "node:assert/strict";
import { ExponentialProgressiveBackoff } from "./exponential-progressive-backoff.js";

const BASE = 5_000;
const MULTIPLIER = 2;
const CEILING = 300_000;

function delayAt(
  consecutiveSuspectTicks: number,
  config: Record<string, unknown> = { multiplier: MULTIPLIER, ceilingMs: CEILING },
): number {
  return new ExponentialProgressiveBackoff().nextDelayMs({ consecutiveSuspectTicks, baseIntervalMs: BASE, config });
}

test("hdl-bp-02: ExponentialProgressiveBackoff tick 1 (first suspect tick, 1-indexed) yields exactly baseIntervalMs — exponent is (1-1)=0, matching static's/progressive's first delay", () => {
  assert.equal(delayAt(1), BASE * MULTIPLIER ** 0);
  assert.equal(delayAt(1), 5_000);
});

test("hdl-bp-02: ExponentialProgressiveBackoff worked wall-clock sequence, multiplier=2, ceilingMs=300000, baseIntervalMs=5000 — independently re-derived per tick, not hardcoded", () => {
  for (let tick = 1; tick <= 12; tick++) {
    const raw = BASE * MULTIPLIER ** (tick - 1); // re-derive from the formula, not a literal table
    const expected = Math.min(raw, CEILING);
    assert.equal(delayAt(tick), expected, `tick ${tick}`);
  }
  // Spot-check the literal sequence from the design discussion's worked example:
  // 5s, 10s, 20s, 40s, 80s, 160s, then 300s (capped) from tick 7 onward.
  assert.deepEqual(
    Array.from({ length: 9 }, (_, i) => delayAt(i + 1)),
    [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000],
  );
});

test("hdl-bp-02: ExponentialProgressiveBackoff boundary — one tick before the ceiling is first hit (tick 6) is not yet capped", () => {
  const raw = BASE * MULTIPLIER ** (6 - 1); // 5000 * 32 = 160000
  assert.equal(raw, 160_000);
  assert.ok(raw < CEILING, "tick 6's raw value must still be below the ceiling for this to be a real boundary check");
  assert.equal(delayAt(6), 160_000);
});

test("hdl-bp-02: ExponentialProgressiveBackoff boundary — exactly the tick where the ceiling is first hit (tick 7)", () => {
  const raw = BASE * MULTIPLIER ** (7 - 1); // 5000 * 64 = 320000
  assert.equal(raw, 320_000);
  assert.ok(raw > CEILING, "tick 7's raw value must exceed the ceiling for the cap to actually engage here");
  assert.equal(delayAt(7), CEILING);
  assert.equal(delayAt(7), 300_000);
});

test("hdl-bp-02: ExponentialProgressiveBackoff boundary — one tick past the ceiling (tick 8) stays capped, does not keep growing", () => {
  assert.equal(delayAt(8), CEILING);
  assert.equal(delayAt(8), 300_000);
});

test("hdl-bp-02: ExponentialProgressiveBackoff stays capped far past the ceiling tick (tick 1000, no overflow/NaN)", () => {
  const result = delayAt(1000);
  assert.equal(result, 300_000);
  assert.ok(Number.isFinite(result), "must never return Infinity/NaN even for huge exponents");
});

test("hdl-bp-02: ExponentialProgressiveBackoff honors a different multiplier/ceiling pair", () => {
  // multiplier=3, ceilingMs=1000, baseIntervalMs=5000: tick1=5000 already >= ceiling? No — baseIntervalMs itself
  // can exceed ceilingMs if misconfigured; the min() must still apply even to the very first tick.
  assert.equal(delayAt(1, { multiplier: 3, ceilingMs: 1_000 }), 1_000, "the ceiling must apply even on tick 1 if baseIntervalMs alone exceeds it");
});

test("hdl-bp-02: ExponentialProgressiveBackoff reports name 'exponential' matching its registry key", () => {
  assert.equal(new ExponentialProgressiveBackoff().name, "exponential");
});
