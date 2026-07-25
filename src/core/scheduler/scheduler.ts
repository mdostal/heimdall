// Scheduler — the pluggable contract every scheduling backend implements.
// Deliberately minimal and backend-agnostic: no cron-specific fields, no
// timer-specific fields. See docs/scheduler-constraints.md and
// .pHive/planning/architecture.md's "Scheduler (post-P0)" section — the
// two concrete backends (MulticaAutopilotScheduler, InProcessScheduler)
// each implement this same interface without leaking their own specifics
// into it.

export interface Scheduler {
  start(): void;
  stop(): void;
}
