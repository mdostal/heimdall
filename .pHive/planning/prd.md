# Heimdall — PRD (v1 / P0 scope)

Source: `.pHive/planning/product-brief.md` (prioritization), `.pHive/planning/product-discovery-brief.md` (full rationale). This PRD expands the Pre-P0 gating spike and P0 features into testable requirements. P1/P2 items are listed for traceability but not expanded in full detail — they are out of scope until P0 ships.

## Requirements Breakdown

### Pre-P0 — Gating Spike

- **REQ-00: Per-provider signal inventory PoC**
  - Source: Product Discovery Brief, Open Question #1 (gating spike)
  - User value: Prevents architecture from being designed around wrong assumptions about what providers actually expose — the flagged load-bearing unknown.
  - Acceptance criteria:
    - Given the Claude (Claude Code) and Codex lanes, when their real API/CLI responses and public status pages are inspected, then produce a written inventory of: error codes seen, quota-reset signal format (if any), payment-failure signal format (if any), and public status-page machine-readability (structured API/RSS vs. HTML-scrape-only).
    - Given the inventory is complete for 2–3 providers, when Architecture begins, then the health-signal design (REQ-02–REQ-05) must cite this inventory as its evidentiary basis, not assumption.
  - **This spike blocks Architecture sign-off — do not proceed to the Architecture document until it is complete.**

### P0 — Health/Status Detection (v1)

- **REQ-01: Passive last-response observation**
  - Source: Discovery brief MVP Scope (health-signal model, layer 1)
  - User value: Free, near-real-time signal from traffic that's already happening — no wasted tokens.
  - Acceptance criteria:
    - Given a lane just handled a real agent request, when the response or error returns, then Heimdall records the lane's inferred state (up / down / out-of-credit / degraded) and, if the response exposes it, the quota-reset time.
    - Given no real traffic has hit a lane recently, when its status is queried, then Heimdall falls back to REQ-02/REQ-03 rather than reporting stale passive data as current.

- **REQ-02: Public status-page piggybacking**
  - Source: Discovery brief MVP Scope (health-signal model, layer 2)
  - User value: Pre-emptively know "expect failures" before spending a single token on a doomed call.
  - Acceptance criteria:
    - Given a provider publishes a public status page/endpoint, when Heimdall checks it, then the check consumes no per-lane API tokens and updates the lane's degraded/down signal if the provider reports an incident.
    - Given a provider's status page is HTML-only (no structured feed), when Heimdall integrates it, then a documented scrape/parse approach exists and is flagged as more brittle than a structured source (traceable to REQ-00's inventory).

- **REQ-03: Sparse active light checks**
  - Source: Discovery brief MVP Scope (health-signal model, layer 3)
  - User value: Fills gaps only when needed, keeping token cost low — explicitly not "poll every lane every 10 seconds."
  - Acceptance criteria:
    - Given passive (REQ-01) and public-status (REQ-02) signals are both stale or insufficient for a lane, when the staleness threshold is exceeded, then Heimdall performs one minimal-cost active check against that lane.
    - Given a lane has recent passive or public-status signal, when a status query arrives, then Heimdall does NOT perform a redundant active check.

- **REQ-04: 4-state lane status model**
  - Source: Discovery brief MVP Scope
  - User value: "Why unavailable" and "when back" is what lets a decision-maker act instead of just react.
  - Acceptance criteria:
    - Given a lane's combined signal (REQ-01–03), when status is computed, then it resolves to exactly one of: `up`, `down`, `out_of_credit` (with `reset_at` if known), or `degraded`.
    - Given a lane is `out_of_credit` and a reset time becomes known (from passive or public data), when queried, then `reset_at` is included in the response.

- **REQ-05: Availability-query tool/API — the `LaneRouterContract`**
  - Source: Discovery brief MVP Scope; contract shape named/gated per operator note (2026-07-25): "the fire-and-forget specialist shape can't answer 'any free lane?'" — same cross-cutting note applied elsewhere in Pantheon.
  - User value: Lets an external decision-maker (Auriga, or Mathew manually) pick a lane without guessing or re-implementing health logic.
  - **Contract shape (binding on all three surfaces — HTTP, CLI, MCP):** `LaneRouterContract` is **synchronous request/response**, never fire-and-forget. A caller issues a query ("any free lane?" / "status of lane X?") and receives a direct answer in that same call. It is explicitly NOT an event/notification/callback interface — a caller must never have to wait for a separate async signal to learn availability. This is a hard interface constraint, not an implementation detail: any future transport (HTTP, CLI, MCP, or a later message-bus integration) must preserve request-in/answer-out semantics.
  - Acceptance criteria:
    - Given at least one lane is configured, when the availability tool/API is queried, then it returns every known lane's current 4-state status plus reason/reset-time metadata where applicable, **in direct response to that query** (no polling-for-a-later-event required by the caller).
    - Given no lanes are configured, when queried, then it returns an empty result, not an error.
    - Given a caller asks "is there any free/up lane right now," when the query executes, then the answer is derivable synchronously from the same response — never "subscribe and wait."

- **REQ-06: 10-second status-correctness SLA**
  - Source: Discovery brief Success Metrics (primary metric)
  - User value: The core trust guarantee the rest of the system depends on.
  - Acceptance criteria:
    - Given a lane's actual health state changes (degrades, goes down, recovers), when up to 10 seconds elapse, then a subsequent query via REQ-05 reflects the new correct state.
    - Given the SLA is met via the layered model (REQ-01–03), when validated, then no test relies on literal fixed-interval active polling as the mechanism.

- **REQ-07: Minimal local credential loading for lane probes**
  - Source: Discovery brief Technical Constraints (local `.env`/vault stopgap) — required for P0 to function at all, since REQ-03's active checks and REQ-01's passive observation both need lane credentials.
  - User value: v1 works today without waiting on Portunus.
  - Acceptance criteria:
    - Given a lane's credential is present in the local `.env`/vault stopgap, when Heimdall starts, then that lane is loadable and probeable.
    - Given a lane's credential is missing or invalid, when Heimdall starts, then that lane is reported as `down`/unconfigured rather than crashing the whole service.

## Gap Report

- **GAP-01**: Exact per-provider staleness threshold for REQ-03 (how stale is "stale enough to warrant a sparse active check") is undefined — recommend resolving during Architecture, informed by REQ-00's spike findings.
- **GAP-02**: Consumption surface for REQ-05 (CLI vs. local HTTP endpoint vs. both) is an open question carried from the discovery brief — resolve during Architecture.
- **GAP-03**: Multi-workstation/multi-instance coordination (if two Heimdall instances run on different workstations, do they share lane state?) is not addressed by any REQ above — flagged as a likely P1/architecture-time question, not a v1 blocker since v1's target scale (30+ consistent agents) may run from a single coordinating instance.

## Scope Boundaries

**In scope (P0):**
- REQ-00 through REQ-07 above.

**Out of scope (P1 — routing heuristic, A/B testing; P2 — standalone settings UI, Portunus):**
- Any lane *selection* logic — P0 only reports status, never chooses a lane. Rationale: explicit v1 boundary from discovery (no splitting logic in v1).
- Standalone settings UI — Rationale: v1 configured via file/API; UI is a standalone-only convenience layer.
- Portunus-backed credential minting — Rationale: local `.env`/vault stopgap (REQ-07) is sufficient for P0; full cross-account minting is a separate prerequisite epic.

## Priority Matrix

| Feature | User Value | Effort | Priority |
|---------|-----------|--------|----------|
| REQ-00 Per-provider signal inventory spike | High — de-risks everything below | Low-Med | P0 (gating) |
| REQ-01 Passive observation | High — free, always-on signal | Low | P0 |
| REQ-02 Public status piggyback | High — pre-emptive, zero token cost | Med | P0 |
| REQ-03 Sparse active checks | Med — fills gaps only | Med | P0 |
| REQ-04 4-state status model | High — core value prop | Low | P0 |
| REQ-05 Availability-query tool | High — the actual deliverable surface | Med | P0 |
| REQ-06 10s SLA | High — the trust contract | Med | P0 |
| REQ-07 Local credential loading | High — nothing works without it | Low | P0 |
| Routing heuristic | High (future) | High | P1 |
| A/B testing infra | Med (future) | Med | P1 |
| Standalone settings UI | Med (future, standalone only) | Med | P2 |
| Portunus integration | High (future, cross-account) | High | P2 |

## Success Metrics

- **status_correctness_sla**: ≤10 seconds from actual lane health change to correct status reflected via REQ-05.
  - Measurement method: Synthetic test harness flips a mock lane's simulated health state and measures time-to-correct-query-response.
- **token_cost_per_status_check**: near-zero marginal token spend per status query under normal conditions (passive/public-status signals dominate; active checks are the rare exception).
  - Measurement method: Count active-check invocations (REQ-03) vs. total status queries over a test window; active-check ratio should be low.
