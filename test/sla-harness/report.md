# SLA Verification Harness — Results

Target SLA: status-correctness within 10000ms of an actual state change (REQ-06).

| Scenario | Ticks | Elapsed (ms) | Final Status | Expected | Error Code | Routes per tick | SLA Met |
|---|---|---|---|---|---|---|---|
| up_stays_up | 1 | 7.43 | up | up | — | sla-harness-lane | ✅ |
| up_to_degraded_single_tick | 1 | 0.68 | degraded | degraded | rate_limit | sla-harness-backup | ✅ |
| up_to_down_requires_two_ticks | 2 | 0.37 | down | down | server_error | sla-harness-backup → sla-harness-backup | ✅ |
| down_to_recovered_single_tick | 3 | 0.59 | up | up | — | sla-harness-backup → sla-harness-backup → sla-harness-lane | ✅ |
| quota_exhausted_fails_over | 3 | 1.59 | out_of_credit | out_of_credit | quota_exceeded | sla-harness-lane → sla-harness-backup → sla-harness-backup | ✅ |
| auth_failure_mid_run_fails_over | 3 | 0.50 | down | down | auth_failed | sla-harness-lane → sla-harness-backup → sla-harness-backup | ✅ |
| slow_lane_stays_routed | 2 | 416.18 | up | up | — | sla-harness-lane → sla-harness-lane | ✅ |
| slow_lane_times_out_fails_over | 2 | 423.65 | down | down | network_error | sla-harness-backup → sla-harness-backup | ✅ |

## Scenario notes

- **up_stays_up**: A healthy lane stays healthy across a tick (sanity baseline) and keeps the route.
- **up_to_degraded_single_tick**: A rate-limited probe (429) resolves to degraded immediately — no corroboration required — and routing moves to the backup lane on that same tick.
- **up_to_down_requires_two_ticks**: A hard failure (503) downgrades to degraded on the first tick (uncorroborated), then corroborates into a trusted `down` on the second consecutive matching tick. Routing leaves the lane on the first tick — it routes only to `up` lanes, so it never waits on corroboration.
- **down_to_recovered_single_tick**: Once corroborated down, a single healthy tick recovers to up immediately — recovery (unlike failure) never needs corroboration — and the lane wins the route back.
- **quota_exhausted_fails_over**: A routed lane hits its weekly cap (429 naming the weekly limit): the first capped tick routes to the backup while the verdict awaits corroboration, the second corroborates `out_of_credit` / quota_exceeded, and the lane stays out of rotation.
- **auth_failure_mid_run_fails_over**: A lane serving traffic reports a failed route outcome with an expired OAuth token. That passive signal alone moves routing to the backup (degraded, awaiting corroboration); the next probe's 401 corroborates `down` / auth_failed.
- **slow_lane_stays_routed**: A lane whose probe answers 200 only after 200ms stays up and keeps the route: routing is health-based, and nothing in it penalises a lane for being slow.
- **slow_lane_times_out_fails_over**: A lane whose probe hangs 200ms and then times out reads as a network failure: routing moves to the backup on the first timeout and the second corroborates `down` / network_error.

## Key finding

down/out_of_credit verdicts require 2 consecutive matching raw signals to corroborate (lhs-03d's corroboration policy, adopted from signal-inventory.md's false-positive-risk finding). A real scheduler must tick often enough that 2 ticks fit comfortably inside the 10s SLA window — e.g. a ~2-4s tick interval, not a single slow poll every 10s.

Routing does not wait on that corroboration: it only routes to lanes whose current status is `up`, so the first suspect tick (`degraded`, awaiting corroboration) already sends traffic to the backup lane. Corroboration only decides what the lane is labelled, not whether it is routed to.

A slow lane is invisible to routing until its probe actually fails. The HTTP active probes pass no timeout to fetch, and CLI probes time out after DEFAULT_COMMAND_TIMEOUT_MS (120s), so a hung probe resolves only when that limit or the HTTP stack gives up — both well outside the 10s SLA. The slow_lane_times_out_fails_over scenario simulates the timeout firing; it does not prove one fires inside the SLA window.
