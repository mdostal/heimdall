import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SCENARIOS, measureTransition, runAllScenarios, renderReport, SLA_MS } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("every scenario resolves to its expected final status", async () => {
  for (const scenario of SCENARIOS) {
    const result = await measureTransition(scenario);
    assert.equal(
      result.finalStatus,
      result.expectedFinalStatus,
      `${scenario.name}: expected ${result.expectedFinalStatus}, got ${result.finalStatus}`,
    );
  }
});

test("every scenario meets the 10-second SLA (REQ-06) — measured, not asserted", async () => {
  for (const scenario of SCENARIOS) {
    const result = await measureTransition(scenario);
    assert.ok(
      result.elapsedMs <= SLA_MS,
      `${scenario.name}: took ${result.elapsedMs}ms, SLA is ${SLA_MS}ms`,
    );
    assert.equal(result.metSla, true);
  }
});

test("a single down probe (no second corroborating tick) does NOT resolve to down", async () => {
  // Guards the corroboration-required-for-down invariant this harness's
  // "up_to_down_requires_two_ticks" scenario documents — a lone failure
  // must not be trusted as `down` within the SLA window.
  const oneTickScenario = {
    name: "single-down-tick-uncorroborated",
    description: "test-only: confirms one failure alone isn't trusted as down",
    ticks: SCENARIOS.find((s) => s.name === "up_to_down_requires_two_ticks")!.ticks.slice(0, 1),
    expectedFinalStatus: "down" as const,
  };
  const result = await measureTransition(oneTickScenario);
  assert.notEqual(result.finalStatus, "down");
  assert.equal(result.finalStatus, "degraded");
});

test("generates and writes the results report to report.md", async () => {
  const results = await runAllScenarios();
  const report = renderReport(results);
  assert.match(report, /SLA Verification Harness/);
  assert.match(report, /up_to_down_requires_two_ticks/);
  writeFileSync(join(__dirname, "report.md"), report, "utf-8");
});
