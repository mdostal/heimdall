# Heimdall — Product Brief

Source: `.pHive/planning/product-discovery-brief.md` (full detail, rationale, competitive research, and session notes live there — this brief is the synthesized, prioritized summary for planning handoff).

## Problem

Mathew (and any operator running a multi-agent AI fleet) hand-manages which provider account/runtime ("lane" — provider × account × runtime) handles which task. This doesn't scale: work piles onto one lane while others idle, a lane silently breaks (e.g. a Codex OAuth hang) or hits its cap, and the fleet stalls because routing isn't health-aware. There is currently zero visibility into *why* a lane is unavailable or *when* it'll recover.

## Target Users

- **Primary:** Mathew, running a bursty multi-agent fleet (target: consistent 30+ agents in v1, growing toward ~300) across multiple workstations, provider accounts (2-5+ per provider), and CLI runtimes (Claude Code, Codex, Gemini, OpenRouter, Kimi K3, Ollama).
- **Secondary:** Any operator/team adopting Heimdall standalone, outside the Pantheon, via any multi-agent-capable harness.

## Core Features

### Pre-P0 — Gating spike (required before architecture locks)
- **Per-provider signal inventory PoC** on 2–3 providers (Claude + Codex first): what does the last real response expose (error codes, quota-reset signals, payment-failure signals)? What do public status pages expose, and how machine-readable are they? This is the load-bearing unknown flagged during discovery — architecture must be designed around what's actually observable, not assumed.

### P0 (v1 — health/status only, no routing logic)
- **Layered health-signal detection per lane**, token-conscious by design:
  1. Passive observation of the last real agent response/error per lane (free).
  2. Public provider status-page piggybacking (cheap, no tokens — pre-emptively flags expected failures).
  3. Sparse active light checks only when passive + public-status signals are stale/insufficient.
- **4-state status model per lane:** up / down / out-of-credit-or-payment-issue (with reset time if known) / degraded.
- **Availability-query tool/API:** "what are my healthy lanes right now, and why/when for the unhealthy ones?" — consumable by an external decision-maker (Auriga, or manually).
- **10-second SLA** on status correctness from an actual state change (met via the layered model, not fixed-interval active polling).

### P1 (v1.5+)
- Routing/splitting heuristic (task-type + headroom + cost-based lane selection), consuming Heimdall's status output as input. Must be easily A/B-testable/reconfigurable — no hard-coded "never use cheap tiers" rule.
- A/B testing of routing heuristics using Heimdall's reported data.

### P2 (later)
- Standalone-only settings UI: sign up new agents/runtimes, see + verify them (v1 configured via file/API instead).
- Cross-account long-lived token minting/storage via Portunus (v1 uses a local `.env`/vault stopgap).

## Success Metrics

- **Primary:** Lane status reflects the correct state within a **10-second SLA** of an actual health change, achieved as detection latency via the layered signal model — not token-costly constant polling.
- **Secondary:** Zero stuck/silently-hung processes going undetected; full visibility into uptime/downtime per lane including cause and expected recovery time.
- **Minimum bar:** 100% of dispatches are gated through Heimdall's status information — no manual "is this lane okay?" checking.

## Scope Boundaries

**In scope (v1):** health/status detection (3-layer model), 4-state status per lane, availability-query tool, 10s SLA.

**Explicitly out of scope (v1, deferred to P1/P2):** routing/splitting logic, standalone settings UI, Portunus integration, A/B testing infrastructure.

**Hard exclusions (never):**
- Rebuilding a full LLM gateway/full stack from scratch — wrap existing backends/patterns (LiteLLM/OmniRoute-style) where useful; Heimdall's value is health/status + the Pantheon lane model, not request-proxying.
- Hard-coding an absolute "never route to cheap tiers" rule — routing policy (P1+) must stay reconfigurable/A-B-testable.

## Open Questions Carried Forward

See full list in the discovery brief. The gating spike (per-provider signal inventory) is the only one blocking architecture; the rest (token-stopgap shape, v1 tool consumption surface — CLI vs. local HTTP vs. both) can be resolved during Architecture.
