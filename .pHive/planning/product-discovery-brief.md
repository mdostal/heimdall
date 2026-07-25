## Product Discovery Brief

### Problem Statement
Mathew (and, by extension, any operator running a multi-agent AI fleet) hand-manages which provider account/runtime handles which task across a growing set of "lanes" (provider × account × runtime — e.g. `claude@mathew.dostal`, `codex`, `gemini-3-pro`, `openrouter/grok`, `ollama-local`). This doesn't scale: work piles onto one lane while others sit idle, a lane silently breaks (e.g. a Codex OAuth hang) or hits its cap, and the fleet stalls because routing isn't health-aware.

### Target Users
- **Primary persona:** Mathew, running a bursty multi-agent fleet across multiple workstations, provider accounts, and CLI runtimes (Claude Code, Codex, Gemini, OpenRouter, Kimi K3, Ollama), scaling from a handful of agents today toward 30+ consistently and up to ~300 at peak as more compute/workstations are attached.
- **Secondary persona:** Any operator/team adopting Heimdall standalone (outside the Pantheon), running multi-agent work through any harness capable of spinning up and directing multiple agents.
- **User evidence:** Personal, direct operational experience — this is the exact hand-managed bottleneck Mathew works around today.

### Competitive Landscape
- **Existing alternatives:** Vercel AI Gateway (hosted, API-key/BYOK only — no subscription-account concept); LiteLLM (mature OSS router: health checks, cooldowns, ordered fallback — but deployment/API-key based, not subscription-aware); OpenRouter (pay-per-token marketplace, not subscription-aware); small OSS tools (CC-Router, claude-switch, swisscode — round-robin/switch across *multiple Claude Max accounts* via OAuth rotation, Claude-only); OmniRoute (closest overall analog — local-first gateway, tiers subscriptions vs free models, circuit breakers/per-key cooldowns, 17 routing strategies including quota-share across team accounts).
- **Key gaps in alternatives:** None expose lane health/availability as a queryable status API for an *external* orchestrator to consume — every existing tool (including OmniRoute) bundles health-checking inside its own request-proxying path. None natively model "lane = provider × account × runtime" the way Pantheon needs, and none integrate with Auriga/Vesta/Multica/Portunus.
- **Build rationale:** v1 scope (health/status detection + an availability-query tool, no routing logic — see MVP Scope) isn't something existing tools solve as a standalone concern; they solve a bigger, bundled problem (request proxying + routing). Native build is right-sized for v1. OmniRoute's circuit-breaker/cooldown design and LiteLLM's health-check-interval pattern are candidate implementation inspirations once a routing heuristic (v1.5+) is built, and either could become an optional backend at that point rather than reimplemented from scratch.

### Value Proposition
- **Core differentiator:** Health-aware status is *actually verified* — via passive last-response observation, public provider status-page piggybacking, and only sparse active checks (never just `--version`, never wasteful constant polling) — and exposed as a queryable API/tool that any orchestrator (Auriga, or a standalone harness) can consume before deciding where to route.
- **Unfair advantage:** Native Pantheon lane model (provider × account × runtime) plus per-account long-lived token handling (via Portunus), and dual-mode distribution (standalone + Pantheon plugin) that no competitor targets.
- **Switching motivation:** Existing tools require adopting their proxying/routing stack wholesale; Heimdall lets you keep hand-rolled or externally-decided routing while getting trustworthy health/status data for free.

### Success Metrics
- **Primary metric:** When a lane's health changes (degrades, goes down, comes back), Heimdall's reported status reflects the correct state within a 10-second SLA — achieved as *detection latency*, not literal fixed-interval polling (see MVP Scope health-signal model below; this is deliberately token-conscious, not "hit every lane every 10s").
- **Secondary metrics:** Zero stuck/silently-hung processes going undetected; visibility into realistic uptime/downtime per lane, including *why* down (dead vs. rate-limited vs. out-of-credit) and *when* it's expected back (quota-reset time, if known); ability to A/B test routing heuristics later using Heimdall's reported data.
- **Minimum success bar:** 100% of dispatches are gated through Heimdall's status information — no manual "is this lane okay?" checking by a human.

### MVP Scope
**In v1:**
- Health/status detection per lane via a **layered, token-conscious signal model** (not naive fixed-interval active polling) — user value: trustworthy, near-real-time signal without burning tokens or wastefully hammering providers:
  1. **Passive observation** — inspect the last real agent response/error on a lane (free — already happening) to infer current state and, where the provider surfaces it, *when usage/quota resets*.
  2. **Public status-page piggybacking** — check the provider's own public status endpoint (e.g. status.anthropic.com-style pages) to pre-emptively flag "expect failures" before even attempting a call — cheap, no tokens spent.
  3. **Sparse active light checks** — only when passive + public-status signals are stale or insufficient, run an occasional minimal-cost check (not `--version` — must reflect a real call) to confirm reachability.
- Status must distinguish more than binary up/down: **up / down / out-of-credit-or-payment-issue (with reset time if known) / degraded** — user value: knowing *why* a lane is unavailable and *when* it'll be back is what lets an external decision-maker act, not just react.
- A tool/API for querying current lane availability ("what are my healthy options right now, and why/when for the unhealthy ones?") — user value: lets an external decision-maker (Auriga, or Mathew manually) pick a lane without guessing.
- Meeting the 10-second status-correctness SLA through the layered model above — user value: the core trust guarantee the rest of the system depends on, without the token cost of constant active probing.

**Deferred to v2+:**
- Routing/splitting heuristic (task-type + headroom + cost-based lane selection) — reason for deferral: v1 explicitly excludes "any logic on splitting"; the heuristic is judged and applied outside Heimdall for now, consuming Heimdall's status output as input.
- Standalone settings UI (sign up new agents/runtimes, see + verify them) — reason for deferral: v1 can be configured via file/API; the UI is a standalone-only convenience layer, not core.
- Cross-account long-lived token minting/storage (Portunus integration) — reason for deferral: flagged in north-star as a blocking prerequisite for cross-account routing, but not required to ship v1's health/status-only scope; v1 can start from a local `.env`/vault stopgap.
- A/B testing of routing heuristics — reason for deferral: depends on the routing heuristic existing first (v2+).

**Hard exclusions (never):**
- Rebuilding a full LLM gateway/full stack from scratch — rationale: wrap existing backends (LiteLLM/OpenRouter-style patterns) where useful instead; Heimdall's value is the health/status + Pantheon lane model, not reinventing request proxying.
- Hard-coding an absolute "never route to cheap tiers" rule inside Heimdall's core logic — rationale: the routing heuristic (v1.5+) must be easily A/B-testable/reconfigurable; cheap-tier eligibility is a policy decision made by whatever consumes Heimdall's status data, potentially driven by the request itself, not a fixed rule baked into the router.

### Technical Constraints
- **Platform:** Backend service/API (headless) — `project_type: service`, `has_ui: false` for the core. A light standalone-only settings UI is a deferred, standalone-mode-only surface (see MVP Scope).
- **Performance:** Health-check/status-correctness SLA of ≤10 seconds from an actual state change, met via the layered passive/public-status/sparse-active-check model (not fixed-interval active polling — token cost must stay low); must handle bursty load scaling from a handful of agents up to a consistent 30+ concurrent agents in v1 (designed to grow toward ~300 as more compute is attached, not required in v1).
- **Compliance:** None identified.
- **Infrastructure:** Local-first / self-hosted preference (matches the operator's existing per-workstation, per-account setup); not a hosted SaaS gateway. Long-lived per-account tokens stored locally (`.env`/vault stopgap) ahead of eventual Portunus integration.
- **Integrations:** Auriga (orchestrator — calls Heimdall per-dispatch), Vesta (config, in Pantheon mode), Multica (in Pantheon mode), Portunus (creds, deferred), and the lane providers themselves (Claude Code, Codex, Gemini, OpenRouter, Kimi K3, Ollama, etc.) via real probe calls per lane. Dual-mode distribution: standalone (any multi-agent-capable harness) + Pantheon plugin.

### Key Decisions Made
- v1 is deliberately narrow: health/status detection + an availability-query tool only. No routing/splitting heuristic ships in v1 — that logic is judged externally for now, consuming Heimdall's status output.
- Primary success metric is a concrete SLA (≤10s status-correctness on degradation/recovery), not a qualitative "no manual routing" statement, to make v1 testable.
- Competitive landscape research (done by Hive, not the operator) concluded a native build is right-sized for v1's narrow scope; no existing tool exposes lane health as a queryable API for an external orchestrator the way Pantheon needs.
- `project_type = service` (primary), `has_ui = false` for the core; a standalone-only settings UI and cross-account token minting (Portunus) are both explicitly deferred past v1.
- Every Pantheon "god" (not just Heimdall) ships OSS + standalone-capable AND as a Pantheon plugin — a distribution property, not a `project_type` change (see `docs/north-star.md` "Finalized kickoff classification").
- Per-provider signal inventory (Open Question #1) is gated as a required spike/PoC on 2–3 providers (Claude + Codex first) *before* architecture locks in — the operator's standing PoC-first rule for load-bearing unknowns, applied elsewhere in Pantheon (Auriga's lock spike, Minerva's Risk-A).

### Open Questions
1. **[GATING SPIKE — required before architecture locks]** Per provider/runtime (Claude Code, Codex, Gemini, OpenRouter, Kimi K3, Ollama): what does the last real response actually expose (error codes, quota-reset headers/messages, payment-failure signals) vs. what a public status page exposes vs. what a sparse light check needs to cover. This is the load-bearing unknown — parsing every provider's reset/degradation signals is exactly where "simple" quietly balloons. PoC on 2–3 providers first (start with Claude and Codex, the two in active daily use), *then* design the architecture around what's actually observable. Same PoC-first pattern as Auriga's lock spike and Minerva's Risk-A.
2. Which public status endpoints exist per provider and how machine-readable are they (structured API/RSS vs. HTML scrape)? Folded into the gating spike above (#1) — answer for the same 2–3 providers before architecture.
3. How does the v1 availability-query tool get consumed in practice before Auriga integration exists — a CLI, a local HTTP endpoint, both?
4. When does the local `.env`/vault stopgap for long-lived tokens get formalized, and what's the minimum viable shape for v1 (single file? per-workstation?) before Portunus exists?

### Session Notes
North-star.md and the kickoff discovery conversation already carried most of Problem Space, Target Users, and Differentiators, so this session focused on the three genuinely open areas: competitive landscape (explicitly delegated to Hive to research rather than answered by the operator), MVP boundary (a real narrowing — v1 dropped from "full health-aware routing" in the north-star draft down to health/status-detection-only, with routing logic explicitly pushed out), and a sharper, testable success metric (10s SLA status-flip correctness replacing the qualitative "100% through Heimdall, zero stuck processes" framing). The operator was decisive and terse throughout — no uncertainty surfaced in the areas discussed.
