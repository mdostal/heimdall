# Design Discussion — Lane Health & Status (Heimdall v1 / P0)

## 1. What Are We Doing?

We're building the first slice of Heimdall: a service that knows whether each configured "lane" (provider × account × runtime — e.g. `claude@mathew.dostal`, `codex`) is actually usable right now, and can answer that question when asked. It does NOT decide which lane to route work to — that's explicitly deferred. Done, for v1, means: three query surfaces (HTTP, CLI, MCP) all backed by one function that returns a 4-state status (up / down / out_of_credit / degraded) per lane, correct within 10 seconds of a real state change, achieved without burning tokens on constant polling.

## 2. What I Found

There's no existing codebase — this is greenfield. The relevant "research" already happened during discovery/PRD/architecture:

- `docs/north-star.md` — the original problem framing (manual lane juggling, silent failures stalling the fleet) plus the finalized project classification (service-primary, headless core, OSS+standalone dual-mode across all Pantheon components).
- `.pHive/planning/product-discovery-brief.md` — competitive landscape research (LiteLLM, OmniRoute, Vercel AI Gateway, small Claude-Max-rotation tools) concluded nothing exposes lane health as a queryable API for an external orchestrator; native build is justified for this narrow scope.
- `.pHive/planning/prd.md` — REQ-00 through REQ-07, each with Given/When/Then acceptance criteria. This design discussion doesn't re-derive those; it's the execution lens on top of them.
- `.pHive/planning/architecture.md` — Node.js/TypeScript, SQLite state store, local `.env`/vault credential stopgap, three query surfaces sharing one `getLaneStatuses()` core function, named `LaneRouterContract` (synchronous request/response — never fire-and-forget, per explicit operator note).

The one open item architecture deliberately left unresolved: REQ-00, the per-provider signal inventory. Nothing else in the plan should get built assuming what that spike will find — the `ProviderSignalAdapter` interface is shaped now, adapter *content* isn't.

## 3. My Proposed Approach

I'd sequence this so REQ-00 lands early but doesn't block everything:

1. **Spike REQ-00 first** (Claude + Codex only) — no code, just a written signal inventory. This is a research artifact, not a slice, but nothing touching `signal-sources/public-status/` or `signal-sources/active-probe/` for those two providers should start before it's done.
2. **In parallel with the spike**, scaffold the parts that don't depend on it: the Node/TS project skeleton, `state-store.ts` (SQLite schema from architecture.md), `credential-source.ts` (local `.env`/vault loader), and a fixture-backed `GET /lanes` HTTP endpoint returning dummy status data. This proves the shape end-to-end before any real provider signal exists.
3. **Wire REQ-01 (passive observation) for Claude first** once real credential loading works — this is the free, always-on signal layer and doesn't need the spike to be fully done (it observes whatever a real response contains; the spike tells us what to look for, but the observation mechanism itself is generic).
4. **Wire REQ-02 (public status piggyback) + REQ-03 (sparse active checks) for Claude**, informed directly by the spike's findings for that provider. This is where the spike output actually gets consumed as adapter content.
5. **Repeat the adapter pattern for Codex** — proves it generalizes to a second provider before assuming it generalizes to all six.
6. **Add CLI and MCP surfaces** on top of the same core query function — no new logic, just two more thin transports over `getLaneStatuses()`.
7. **Build the SLA verification harness (REQ-06)** last, once there's real signal behavior to measure against — a synthetic harness that flips a mock lane's state and times the correct-response latency.

Gemini, OpenRouter, Kimi K3, and Ollama adapters are explicitly NOT in this epic — v1 proves the pattern on two providers; more adapters are a follow-on, not a blocker.

## 4. What Could Go Wrong

- **[High] REQ-00's findings could force an architecture change mid-build.** If Claude/Codex expose quota-reset or payment-failure signals in wildly incompatible shapes, the clean `ProviderSignalAdapter` interface in architecture.md might need to grow an escape hatch. Mitigation: the spike runs and gets reviewed *before* any adapter-content story starts — if the interface needs to change, it changes before two providers' worth of code has to be reworked, not after.
- **[Medium] "Sparse active check" staleness threshold is unspecified** (PRD GAP-01). Picking a bad default either wastes tokens (too aggressive) or blows the 10s SLA (too lazy). Mitigation: make it a per-adapter config value with a conservative default, tune once the SLA harness (slice 6) can actually measure it.
- **[Medium] Public status-page scraping is inherently brittle** if a provider doesn't offer a structured feed — HTML layout changes silently break the signal. Mitigation: the spike should explicitly flag which providers are structured vs. scrape-only (already called out in PRD REQ-02's acceptance criteria); scrape-only providers get flagged as higher-maintenance, not silently trusted the same as structured ones.
- **[Low] Local `.env`/vault credential loading is a known-temporary stopgap** (Portunus is the real answer, deferred to P2). Mitigation: `credential-source.ts` is designed as a swappable interface specifically so this doesn't become load-bearing tech debt.
- **[Low] Single-instance SQLite assumption (GAP-03)** — fine for v1's target scale (single coordinating instance), but would need real thought if Mathew runs Heimdall from two workstations simultaneously before a routing heuristic exists to reconcile them. Explicitly out of scope for this epic; flagged for whoever picks up P1.

## 5. Dependencies and Constraints

- **REQ-00 gating spike is a hard dependency** for any Claude/Codex adapter-content story — this is the one true blocking dependency in the whole plan.
- **No external service dependencies for v1** — everything is local (SQLite file, local credential file). No cloud infra to provision.
- **Node.js + TypeScript tooling** needs to exist in the repo before any story can run — this epic's first story is the project scaffold itself (there is no existing `package.json` yet).
- **No time-sensitive factors** — no deprecations or external API changes riding a clock here.

## 6. Open Questions

1. What's the actual staleness threshold for triggering a sparse active check (REQ-03 / GAP-01)? Proposing this gets a config default set during the credential/passive-observation story and tuned once the SLA harness exists — not blocking story decomposition, but flagging it so whoever implements REQ-03 doesn't invent a number in a vacuum.
2. Consumption surface priority (PRD GAP-02) — HTTP first, or CLI first? I'm defaulting to HTTP-first (it's the substrate both CLI and MCP wrap), but if Mathew's day-to-day usage is CLI-only for a while, that ordering could flip.
3. Should the spike (REQ-00) produce a literal checked-in document (like this plan's own docs), or is a design-discussion note inside the story sufficient? Defaulting to a checked-in artifact under `.pHive/epics/lane-health-status/docs/` since architecture explicitly cites it as the evidentiary basis for adapter design.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: Node.js test runner (node:test) or Vitest for unit/integration tests; a
         custom synthetic harness for the SLA measurement (REQ-06) — no existing
         framework fits "flip mock lane state, measure time-to-correct-response."
  Platforms: local macOS/Linux service process — no mobile/browser surface in v1.
  Automated: status-model resolution logic (REQ-04), state-store read/write (data
         model), credential loading success/failure paths (REQ-07), the three API
         surfaces returning identical shapes for the same underlying state (REQ-05),
         and the SLA harness itself (REQ-06).
  Manual: actually watching a real Claude/Codex lane go through a real degraded
         state during REQ-00's spike and the subsequent adapter stories — the
         cheapest way to sanity-check the signal model against reality before
         over-investing in automated fixtures for signals we haven't seen yet.
  Not verifying: multi-instance coordination (GAP-03, out of scope this epic),
         adapters for Gemini/OpenRouter/Kimi K3/Ollama (not in this epic), any
         routing/selection logic (explicitly P1, not built here at all).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~15-20 (service skeleton, state-store, credential-source,
    2 provider adapter pairs, 3 API surface files, SLA harness, tests)
  Subsystems: signal detection (3 layers), state storage, credential loading,
    3 query transports (HTTP/CLI/MCP)
  Migration required: no (greenfield, no existing data)
  Cross-team coordination: no (solo operator)
  Unknowns: 1 major (REQ-00 spike outcome — explicitly gated, not guessed at)

  RECOMMENDATION: Needs Horizontal + Vertical planning before story decomposition
  RATIONALE: Multi-file, multiple layers (signal detection / storage / three
    transports), cross-stack in the sense of "one core function, three thin
    wrappers" — not large enough to need a full structured outline (no migration,
    no cross-team coordination, no compliance surface), but thin-slicing matters
    here specifically because of the REQ-00 dependency: getting the slice
    boundaries right is what lets non-spike-dependent work proceed in parallel
    with non-spike-dependent work instead of accidentally serializing everything
    behind the spike.
```
