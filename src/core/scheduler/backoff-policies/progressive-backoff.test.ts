import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgressiveBackoff } from "./progressive-backoff.js";

const BASE = 5_000;
const LEVEL_CAP = 10;

function delayAt(consecutiveSuspectTicks: number, config: Record<string, unknown> = { levelCap: LEVEL_CAP }): number {
  return new ProgressiveBackoff().nextDelayMs({ consecutiveSuspectTicks, baseIntervalMs: BASE, config });
}

test("hdl-bp-02: ProgressiveBackoff tick 1 (first suspect tick, 1-indexed) yields exactly baseIntervalMs, matching static's first delay", () => {
  assert.equal(delayAt(1), BASE * Math.min(1, LEVEL_CAP));
  assert.equal(delayAt(1), 5_000);
});

test("hdl-bp-02: ProgressiveBackoff worked wall-clock sequence, levelCap=10, baseIntervalMs=5000 — independently re-derived per tick, not hardcoded", () => {
  for (let tick = 1; tick <= LEVEL_CAP; tick++) {
    const expected = BASE * Math.min(tick, LEVEL_CAP); // re-derive from the formula, not a literal table
    assert.equal(delayAt(tick), expected, `tick ${tick}`);
  }
  // Spot-check the literal sequence from the design discussion's worked example.
  assert.deepEqual(
    Array.from({ length: LEVEL_CAP }, (_, i) => delayAt(i + 1)),
    [5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000],
  );
});

test("hdl-bp-02: ProgressiveBackoff cumulative sum from tick 1 to tick 10 is 275000ms (arithmetic series 5*(1+2+...+10)=5*55=275)", () => {
  let cumulative = 0;
  for (let tick = 1; tick <= LEVEL_CAP; tick++) {
    cumulative += delayAt(tick);
  }
  const expectedSum = BASE * ((LEVEL_CAP * (LEVEL_CAP + 1)) / 2); // 5000 * 55
  assert.equal(expectedSum, 275_000, "sanity-check the arithmetic-series formula itself");
  assert.equal(cumulative, 275_000);
});

test("hdl-bp-02: ProgressiveBackoff boundary — one tick before levelCap (tick 9) is not yet capped", () => {
  assert.equal(delayAt(9), BASE * 9);
  assert.equal(delayAt(9), 45_000);
});

test("hdl-bp-02: ProgressiveBackoff boundary — exactly at levelCap (tick 10) reaches the cap value", () => {
  assert.equal(delayAt(10), BASE * LEVEL_CAP);
  assert.equal(delayAt(10), 50_000);
});

test("hdl-bp-02: ProgressiveBackoff boundary — one tick past levelCap (tick 11) holds at the same capped value as tick 10", () => {
  assert.equal(delayAt(11), delayAt(10));
  assert.equal(delayAt(11), 50_000);
});

test("hdl-bp-02: ProgressiveBackoff holds at the cap far past levelCap (tick 1000)", () => {
  assert.equal(delayAt(1000), 50_000);
});

test("hdl-bp-02: ProgressiveBackoff defaults levelCap to 10 when config omits it", () => {
  assert.equal(delayAt(10, {}), 50_000);
  assert.equal(delayAt(11, {}), 50_000, "default cap of 10 must still apply past tick 10");
});

test("hdl-bp-02: ProgressiveBackoff honors an explicit non-default levelCap", () => {
  assert.equal(delayAt(3, { levelCap: 3 }), BASE * 3);
  assert.equal(delayAt(4, { levelCap: 3 }), BASE * 3, "capped at the explicit levelCap of 3, not the default 10");
});

test("hdl-bp-02: ProgressiveBackoff reports name 'progressive' matching its registry key", () => {
  assert.equal(new ProgressiveBackoff().name, "progressive");
});
