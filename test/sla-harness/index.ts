// SLA verification harness (REQ-06, lhs-06) — the final story of v1 (P0).
// Flips a mock lane's simulated health state across successive refresh
// "ticks" (each tick = one LanePipeline.refresh() call, as a real scheduler
// would invoke periodically) and measures wall-clock time from the first
// tick to the moment the correct new state is queryable, asserting it stays
// within the 10-second SLA (REQ-06) — measured, not asserted by fiat.
//
// IMPORTANT SCOPE NOTE: no scheduler exists yet in this codebase (explicitly
// out of scope — see architecture.md's "in-process interval timer" as a
// future addition). This harness drives ticks directly rather than waiting
// on a real timer, so what it actually measures is "given N refresh ticks
// happen, is the pipeline+state-store round-trip itself fast enough to stay
// well inside the SLA" — trivially true since ticks here are near-instant
// (mocked network calls). The SLA-meaningful operational conclusion this
// harness supports is: a real scheduler must tick at least as often as the
// number of ticks a scenario needs (see the corroboration finding below),
// within the 10s window — that scheduler-interval choice is a deployment
// concern this harness informs but does not itself configure.
//
// KEY FINDING surfaced by this harness (see report.md): down/out_of_credit
// verdicts require 2 consecutive matching raw signals to corroborate
// (lhs-03d's corroboration policy). A scheduler ticking slower than ~5s
// would risk not corroborating a real outage within the 10s SLA window —
// this is a concrete, measured constraint on scheduler interval choice, not
// a hypothetical.

import { LanePipeline, claudeAdapters, type RefreshDeps } from "../../src/core/lane-pipeline.js";
import { StateStore } from "../../src/core/state-store.js";
import type { Lane } from "../../src/core/lane-registry.js";
import type { LaneStatusValue } from "../../src/core/status-model.js";

export const SLA_MS = 10_000;

export interface TransitionScenario {
  name: string;
  description: string;
  /** One fetch-impl factory per simulated refresh tick, applied in order. */
  ticks: Array<() => typeof fetch>;
  expectedFinalStatus: LaneStatusValue;
}

export interface MeasurementResult {
  scenario: string;
  description: string;
  tickCount: number;
  elapsedMs: number;
  finalStatus: string;
  expectedFinalStatus: string;
  metSla: boolean;
}

function probeFetch(status: number): typeof fetch {
  return (async (url: unknown) => {
    if (typeof url === "string" && url.includes("status.claude.com")) {
      return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
    } as unknown as Response;
  }) as typeof fetch;
}

export const SCENARIOS: TransitionScenario[] = [
  {
    name: "up_stays_up",
    description: "A healthy lane stays healthy across a tick (sanity baseline).",
    ticks: [() => probeFetch(200)],
    expectedFinalStatus: "up",
  },
  {
    name: "up_to_degraded_single_tick",
    description:
      "A rate-limited probe (429) resolves to degraded immediately — no corroboration required.",
    ticks: [() => probeFetch(429)],
    expectedFinalStatus: "degraded",
  },
  {
    name: "up_to_down_requires_two_ticks",
    description:
      "A hard failure (503) downgrades to degraded on the first tick (uncorroborated), then " +
      "corroborates into a trusted `down` on the second consecutive matching tick.",
    ticks: [() => probeFetch(503), () => probeFetch(503)],
    expectedFinalStatus: "down",
  },
  {
    name: "down_to_recovered_single_tick",
    description:
      "Once corroborated down, a single healthy tick recovers to up immediately — recovery " +
      "(unlike failure) never needs corroboration.",
    ticks: [() => probeFetch(503), () => probeFetch(503), () => probeFetch(200)],
    expectedFinalStatus: "up",
  },
];

export async function measureTransition(scenario: TransitionScenario): Promise<MeasurementResult> {
  const store = new StateStore(":memory:");
  const lane: Lane = {
    lane_id: "sla-harness-lane",
    provider: "claude",
    credential_ref: "SLA_HARNESS_TOKEN",
    credential: "fake-credential",
  };
  store.upsertLane({
    lane_id: lane.lane_id,
    provider: lane.provider,
    credential_ref: lane.credential_ref,
  });

  // Indirection so the pipeline (constructed once, preserving corroboration
  // state across ticks) can still use a different fetch behavior per tick.
  let currentFetchImpl: typeof fetch = scenario.ticks[0]();
  const deps: RefreshDeps = {
    now: () => new Date().toISOString(),
    lastPassiveResponse: () => null,
    fetchImpl: ((...args: Parameters<typeof fetch>) => currentFetchImpl(...args)) as typeof fetch,
  };
  const pipeline = new LanePipeline(store, deps, claudeAdapters());

  const start = performance.now();
  let finalStatus = "";
  for (const tickFetchFactory of scenario.ticks) {
    currentFetchImpl = tickFetchFactory();
    await pipeline.refresh(lane);
    finalStatus = store.getCurrentStatus(lane.lane_id)?.status ?? "";
  }
  const elapsedMs = performance.now() - start;
  store.close();

  return {
    scenario: scenario.name,
    description: scenario.description,
    tickCount: scenario.ticks.length,
    elapsedMs,
    finalStatus,
    expectedFinalStatus: scenario.expectedFinalStatus,
    metSla: elapsedMs <= SLA_MS && finalStatus === scenario.expectedFinalStatus,
  };
}

export async function runAllScenarios(): Promise<MeasurementResult[]> {
  const results: MeasurementResult[] = [];
  for (const scenario of SCENARIOS) {
    results.push(await measureTransition(scenario));
  }
  return results;
}

export function renderReport(results: MeasurementResult[]): string {
  const lines = [
    "# SLA Verification Harness — Results",
    "",
    `Target SLA: status-correctness within ${SLA_MS}ms of an actual state change (REQ-06).`,
    "",
    "| Scenario | Ticks | Elapsed (ms) | Final Status | Expected | SLA Met |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.scenario} | ${r.tickCount} | ${r.elapsedMs.toFixed(2)} | ${r.finalStatus} | ${r.expectedFinalStatus} | ${r.metSla ? "✅" : "❌"} |`,
    ),
    "",
    "## Scenario notes",
    "",
    ...SCENARIOS.map((s) => `- **${s.name}**: ${s.description}`),
    "",
    "## Key finding",
    "",
    "down/out_of_credit verdicts require 2 consecutive matching raw signals to " +
      "corroborate (lhs-03d's corroboration policy, adopted from " +
      "signal-inventory.md's false-positive-risk finding). A real scheduler " +
      "must tick often enough that 2 ticks fit comfortably inside the 10s SLA " +
      "window — e.g. a ~2-4s tick interval, not a single slow poll every 10s.",
    "",
  ];
  return lines.join("\n");
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const results = await runAllScenarios();
  console.log(renderReport(results));
}
