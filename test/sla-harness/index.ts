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
// PANT-1000: every scenario also asserts the ROUTING outcome per tick. The
// harness lane is a claude lane next to an always-up codex backup lane, and
// after each tick getAvailableRoute("review", ...) (the default priority
// strategy, which ranks claude ahead of codex for review work) must pick the
// lane the scenario expects — so "lane is unhealthy" is proven to mean
// "traffic went to the backup", not just "a status row changed". Ticks can
// also carry a reported route outcome, fed through the same consume-once
// RouteOutcomeTracker composeService() uses, to model a failure observed on
// real routed traffic mid-run (heimdall#96).
//
// KEY FINDING surfaced by this harness (see report.md): down/out_of_credit
// verdicts require 2 consecutive matching raw signals to corroborate
// (lhs-03d's corroboration policy). A scheduler ticking slower than ~5s
// would risk not corroborating a real outage within the 10s SLA window —
// this is a concrete, measured constraint on scheduler interval choice, not
// a hypothetical.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LanePipeline, claudeAdapters, type RefreshDeps } from "../../src/core/lane-pipeline.js";
import { StateStore } from "../../src/core/state-store.js";
import { LaneRegistry, type Lane } from "../../src/core/lane-registry.js";
import { getAvailableRoute } from "../../src/core/route-selector.js";
import {
  RouteOutcomeTracker,
  routeOutcomeToPassiveResponse,
  type RouteOutcomeReport,
} from "../../src/core/signal-sources/route-outcome.js";
import type { ErrorCode, LaneStatusValue } from "../../src/core/status-model.js";

export const SLA_MS = 10_000;

/** The lane whose health each scenario flips. */
export const HARNESS_LANE_ID = "sla-harness-lane";
/** An always-up lane routing must fall over to once the harness lane isn't up. */
export const BACKUP_LANE_ID = "sla-harness-backup";

export interface TransitionTick {
  /** The fetch behavior the harness lane's probe sees on this tick. */
  fetch: () => typeof fetch;
  /** A route outcome reported for the harness lane just before this tick's
   * refresh. It is passive evidence, so it decides the tick ahead of the probe. */
  outcome?: RouteOutcomeReport;
  /** The lane getAvailableRoute() must choose once this tick has refreshed. */
  expectedRoute: string;
}

export interface TransitionScenario {
  name: string;
  description: string;
  /** One entry per simulated refresh tick, applied in order. */
  ticks: TransitionTick[];
  expectedFinalStatus: LaneStatusValue;
  /** Checked only when set: the error_code the final status must carry. */
  expectedFinalErrorCode?: ErrorCode;
}

export interface MeasurementResult {
  scenario: string;
  description: string;
  tickCount: number;
  elapsedMs: number;
  finalStatus: string;
  expectedFinalStatus: string;
  finalErrorCode: string | null;
  /** The lane routed to after each tick, in tick order. */
  routes: string[];
  expectedRoutes: string[];
  metSla: boolean;
}

// The latency the slow-lane scenarios inject per probe — long enough that the
// measured elapsed time visibly includes it, short enough to keep `npm test` quick.
export const SLOW_PROBE_DELAY_MS = 200;

interface ProbeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Delay before the probe answers (or rejects), simulating a slow lane. */
  delayMs?: number;
  /** Reject instead of answering, the way a fetch that times out does. */
  error?: Error;
}

function probeFetch(reply: number | ProbeReply): typeof fetch {
  const { status, body, headers, delayMs, error } = typeof reply === "number" ? { status: reply } : reply;
  return (async (url: unknown) => {
    if (typeof url === "string" && url.includes("status.claude.com")) {
      return new Response(JSON.stringify({ components: [] }), { status: 200 });
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (error) throw error;
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
}

function weeklyLimitReply(): ProbeReply {
  return {
    status: 429,
    body: { type: "error", error: { type: "rate_limit_error", message: "Your weekly limit has been reached." } },
    headers: { "anthropic-ratelimit-requests-reset": "2026-10-18T00:00:00Z" },
  };
}

function timedOutReply(): ProbeReply {
  return {
    status: 0,
    delayMs: SLOW_PROBE_DELAY_MS,
    error: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
  };
}

const expiredOAuthOutcome: RouteOutcomeReport = {
  outcome: "failed",
  metadata: { error: { status: 401, message: "OAuth access token has expired." } },
};

export const SCENARIOS: TransitionScenario[] = [
  {
    name: "up_stays_up",
    description: "A healthy lane stays healthy across a tick (sanity baseline) and keeps the route.",
    ticks: [{ fetch: () => probeFetch(200), expectedRoute: HARNESS_LANE_ID }],
    expectedFinalStatus: "up",
  },
  {
    name: "up_to_degraded_single_tick",
    description:
      "A rate-limited probe (429) resolves to degraded immediately — no corroboration required — " +
      "and routing moves to the backup lane on that same tick.",
    ticks: [{ fetch: () => probeFetch(429), expectedRoute: BACKUP_LANE_ID }],
    expectedFinalStatus: "degraded",
    expectedFinalErrorCode: "rate_limit",
  },
  {
    name: "up_to_down_requires_two_ticks",
    description:
      "A hard failure (503) downgrades to degraded on the first tick (uncorroborated), then " +
      "corroborates into a trusted `down` on the second consecutive matching tick. Routing " +
      "leaves the lane on the first tick — it routes only to `up` lanes, so it never waits on corroboration.",
    ticks: [
      { fetch: () => probeFetch(503), expectedRoute: BACKUP_LANE_ID },
      { fetch: () => probeFetch(503), expectedRoute: BACKUP_LANE_ID },
    ],
    expectedFinalStatus: "down",
    expectedFinalErrorCode: "server_error",
  },
  {
    name: "down_to_recovered_single_tick",
    description:
      "Once corroborated down, a single healthy tick recovers to up immediately — recovery " +
      "(unlike failure) never needs corroboration — and the lane wins the route back.",
    ticks: [
      { fetch: () => probeFetch(503), expectedRoute: BACKUP_LANE_ID },
      { fetch: () => probeFetch(503), expectedRoute: BACKUP_LANE_ID },
      { fetch: () => probeFetch(200), expectedRoute: HARNESS_LANE_ID },
    ],
    expectedFinalStatus: "up",
  },
  {
    name: "quota_exhausted_fails_over",
    description:
      "A routed lane hits its weekly cap (429 naming the weekly limit): the first capped tick " +
      "routes to the backup while the verdict awaits corroboration, the second corroborates " +
      "`out_of_credit` / quota_exceeded, and the lane stays out of rotation.",
    ticks: [
      { fetch: () => probeFetch(200), expectedRoute: HARNESS_LANE_ID },
      { fetch: () => probeFetch(weeklyLimitReply()), expectedRoute: BACKUP_LANE_ID },
      { fetch: () => probeFetch(weeklyLimitReply()), expectedRoute: BACKUP_LANE_ID },
    ],
    expectedFinalStatus: "out_of_credit",
    expectedFinalErrorCode: "quota_exceeded",
  },
  {
    name: "auth_failure_mid_run_fails_over",
    description:
      "A lane serving traffic reports a failed route outcome with an expired OAuth token. That " +
      "passive signal alone moves routing to the backup (degraded, awaiting corroboration); the " +
      "next probe's 401 corroborates `down` / auth_failed.",
    ticks: [
      { fetch: () => probeFetch(200), expectedRoute: HARNESS_LANE_ID },
      { fetch: () => probeFetch(200), outcome: expiredOAuthOutcome, expectedRoute: BACKUP_LANE_ID },
      { fetch: () => probeFetch(401), expectedRoute: BACKUP_LANE_ID },
    ],
    expectedFinalStatus: "down",
    expectedFinalErrorCode: "auth_failed",
  },
  {
    name: "slow_lane_stays_routed",
    description:
      `A lane whose probe answers 200 only after ${SLOW_PROBE_DELAY_MS}ms stays up and keeps the ` +
      "route: routing is health-based, and nothing in it penalises a lane for being slow.",
    ticks: [
      { fetch: () => probeFetch({ status: 200, delayMs: SLOW_PROBE_DELAY_MS }), expectedRoute: HARNESS_LANE_ID },
      { fetch: () => probeFetch({ status: 200, delayMs: SLOW_PROBE_DELAY_MS }), expectedRoute: HARNESS_LANE_ID },
    ],
    expectedFinalStatus: "up",
  },
  {
    name: "slow_lane_times_out_fails_over",
    description:
      `A lane whose probe hangs ${SLOW_PROBE_DELAY_MS}ms and then times out reads as a network ` +
      "failure: routing moves to the backup on the first timeout and the second corroborates `down` / network_error.",
    ticks: [
      { fetch: () => probeFetch(timedOutReply()), expectedRoute: BACKUP_LANE_ID },
      { fetch: () => probeFetch(timedOutReply()), expectedRoute: BACKUP_LANE_ID },
    ],
    expectedFinalStatus: "down",
    expectedFinalErrorCode: "network_error",
  },
];

export async function measureTransition(scenario: TransitionScenario): Promise<MeasurementResult> {
  const store = new StateStore(":memory:");
  const registry = new LaneRegistry(
    [
      { lane_id: HARNESS_LANE_ID, provider: "claude", credential_ref: "SLA_HARNESS_TOKEN" },
      { lane_id: BACKUP_LANE_ID, provider: "codex", credential_ref: "SLA_HARNESS_BACKUP_TOKEN" },
    ],
    { resolve: () => "fake-credential" },
  );
  const lane = registry.get(HARNESS_LANE_ID)!;
  for (const declared of registry.list()) {
    store.upsertLane({
      lane_id: declared.lane_id,
      provider: declared.provider,
      credential_ref: declared.credential_ref,
    });
  }
  store.recordStatus({
    lane_id: BACKUP_LANE_ID,
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "active_probe",
    observed_at: new Date().toISOString(),
  });

  // Indirection so the pipeline (constructed once, preserving corroboration
  // state across ticks) can still use a different fetch behavior per tick.
  let currentFetchImpl: typeof fetch = scenario.ticks[0].fetch();
  const routeOutcomes = new RouteOutcomeTracker();
  const deps: RefreshDeps = {
    now: () => new Date().toISOString(),
    lastPassiveResponse: (laneId) => routeOutcomes.take(laneId),
    fetchImpl: ((...args: Parameters<typeof fetch>) => currentFetchImpl(...args)) as typeof fetch,
  };
  const pipeline = new LanePipeline(store, deps, claudeAdapters());

  const start = performance.now();
  let finalStatus = "";
  let finalErrorCode: string | null = null;
  const routes: string[] = [];
  for (const tick of scenario.ticks) {
    currentFetchImpl = tick.fetch();
    if (tick.outcome) {
      const passive = routeOutcomeToPassiveResponse(tick.outcome, new Date());
      if (passive) routeOutcomes.record(lane.lane_id, passive);
    }
    await pipeline.refresh(lane);
    const current = store.getCurrentStatus(lane.lane_id);
    finalStatus = current?.status ?? "";
    finalErrorCode = current?.error_code ?? null;
    routes.push(getAvailableRoute("review", registry, store)?.lane_id ?? "");
  }
  const elapsedMs = performance.now() - start;
  store.close();

  const expectedRoutes = scenario.ticks.map((tick) => tick.expectedRoute);
  return {
    scenario: scenario.name,
    description: scenario.description,
    tickCount: scenario.ticks.length,
    elapsedMs,
    finalStatus,
    expectedFinalStatus: scenario.expectedFinalStatus,
    finalErrorCode,
    routes,
    expectedRoutes,
    metSla:
      elapsedMs <= SLA_MS &&
      finalStatus === scenario.expectedFinalStatus &&
      (scenario.expectedFinalErrorCode === undefined || finalErrorCode === scenario.expectedFinalErrorCode) &&
      routes.every((route, i) => route === expectedRoutes[i]),
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
    "| Scenario | Ticks | Elapsed (ms) | Final Status | Expected | Error Code | Routes per tick | SLA Met |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.scenario} | ${r.tickCount} | ${r.elapsedMs.toFixed(2)} | ${r.finalStatus} | ${r.expectedFinalStatus} | ${r.finalErrorCode ?? "—"} | ${r.routes.join(" → ")} | ${r.metSla ? "✅" : "❌"} |`,
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
    "Routing does not wait on that corroboration: it only routes to lanes whose " +
      "current status is `up`, so the first suspect tick (`degraded`, awaiting " +
      "corroboration) already sends traffic to the backup lane. Corroboration " +
      "only decides what the lane is labelled, not whether it is routed to.",
    "",
    "A slow lane is invisible to routing until its probe actually fails. The " +
      "HTTP active probes pass no timeout to fetch, and CLI probes time out " +
      "after DEFAULT_COMMAND_TIMEOUT_MS (120s), so a hung probe resolves only " +
      "when that limit or the HTTP stack gives up — both well outside the 10s " +
      "SLA. The slow_lane_times_out_fails_over scenario simulates the timeout " +
      "firing; it does not prove one fires inside the SLA window.",
    "",
  ];
  return lines.join("\n");
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

// The tracked report.md is only ever rewritten here, by `npm run sla-report`,
// never by `npm test` — the test suite writes its copy to a temp dir so a
// plain test run leaves the working tree clean.
export const REPORT_PATH = join(dirname(fileURLToPath(import.meta.url)), "report.md");

if (isMainModule) {
  const results = await runAllScenarios();
  const report = renderReport(results);
  writeFileSync(REPORT_PATH, report, "utf-8");
  console.log(report);
}
