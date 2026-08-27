# SLA Verification Harness — Results

Target SLA: status-correctness within 10000ms of an actual state change (REQ-06).

| Scenario | Ticks | Elapsed (ms) | Final Status | Expected | SLA Met |
|---|---|---|---|---|---|
| up_stays_up | 1 | 0.06 | up | up | ✅ |
| up_to_degraded_single_tick | 1 | 0.07 | degraded | degraded | ✅ |
| up_to_down_requires_two_ticks | 2 | 0.10 | down | down | ✅ |
| down_to_recovered_single_tick | 3 | 0.17 | up | up | ✅ |

## Scenario notes

- **up_stays_up**: A healthy lane stays healthy across a tick (sanity baseline).
- **up_to_degraded_single_tick**: A rate-limited probe (429) resolves to degraded immediately — no corroboration required.
- **up_to_down_requires_two_ticks**: A hard failure (503) downgrades to degraded on the first tick (uncorroborated), then corroborates into a trusted `down` on the second consecutive matching tick.
- **down_to_recovered_single_tick**: Once corroborated down, a single healthy tick recovers to up immediately — recovery (unlike failure) never needs corroboration.

## Key finding

down/out_of_credit verdicts require 2 consecutive matching raw signals to corroborate (lhs-03d's corroboration policy, adopted from signal-inventory.md's false-positive-risk finding). A real scheduler must tick often enough that 2 ticks fit comfortably inside the 10s SLA window — e.g. a ~2-4s tick interval, not a single slow poll every 10s.
