# Heimdall — North Star

Heimdall is the Pantheon's **health-aware LLM/lane router.** It automates what Mathew does by hand today: spreading agent work across providers AND accounts by available headroom. Every lane = provider × account × runtime, each with its own long-lived creds: `claude@mathew.dostal`, `claude@dostalmathew`, `fable`, `codex`, `gemini-3-pro`, `openrouter/grok`, `ollama-local`.

## Problem it solves
- Work piles onto one lane while others sit idle; a lane hits its weekly cap or a runtime silently breaks (codex OAuth hang) and the fleet stalls — because routing isn't health-aware.
- Mathew hand-manages which account/runtime does what. Doesn't scale; it's the recurring bottleneck.

## What it does (v1)
- **Health-aware:** only routes to a lane that's actually *emitting* — a `--version` isn't proof; probe a real cheap call first. Track per-lane headroom (weekly/usage caps).
- **Route by task-type + headroom + cost:** premium/architecture → Claude/Fable; bulk/grunt → cheaper lanes; images → Gemini Nano Banana; never route real feature work to a distrusted cheap tier.
- **Spread, don't pile:** distribute across healthy lanes; on rate-limit swap lanes, don't halt; recover (reassign) don't recreate.
- **Config-driven + transparent:** which lane handled what is visible (ties Vesta config + the usage/cost dashboard).
- **Interface:** a router the orchestrator (Auriga) calls per dispatch — input `{task-type, est-cost, constraints}` → output `{chosen lane + creds handle}`. Can wrap LiteLLM/OpenRouter as a backend; NOT a full gateway rebuild.

## Key dependency
Per-account **long-lived tokens** for every lane — the thing that makes cross-account sharing real. Minting + storing them (harness-side / Portunus) is a prerequisite; flag it as blocking for cross-account routing.

## Ties
model-routing-diversification · failures-are-our-automation (broken health-aware routing = root cause) · runtime-must-emit-output (probe before routing) · account-identity-model (per-account tokens) · Portunus (creds) · Vesta (config).

## Finalized kickoff classification (Mathew 2026-07-25)

- **project_type = SERVICE** (primary). Core = a health-aware router/dispatcher other components *call*. The framework/plugin-interface pieces are **secondary** — the adapter that lets it plug into Pantheon or run standalone.
- **has_ui = No** for the core (headless service). A **light standalone-settings UI** exists as a secondary, **standalone-only** surface: sign up new agents/runtimes, add runtimes (API calls + a way to **SEE and verify** them). In Pantheon that config lives through other plugins (Vesta / Multica), NOT in Heimdall.
- **OSS + STANDALONE (applies to ALL gods, not just Heimdall):** every plugin is open-source and ships a **standalone version** that works with *any* harness allowing multi-agent spin-up (choose agents + direct them), AS WELL AS plugging into the greater Pantheon for the full vision. So Heimdall builds for **two modes**: standalone (carries its own light config UI) + Pantheon-plugin (config via Vesta/Multica; the two work together). This is a distribution property, not a change to project_type.
