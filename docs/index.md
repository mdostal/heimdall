---
title: Home
nav_order: 1
---

# Heimdall Docs

**Heimdall** is the health-aware lane gateway and router for [Pantheon](https://github.com/mdostal/pantheon-v2). It watches every LLM/runtime *lane*, reports whether each one is `up`, `down`, `out_of_credit`, or `degraded`, and routes tasks to the best healthy lane via a pluggable strategy.

## Quick links

| Where to start | What you need |
|---|---|
| [Getting Started](getting-started.md) | Install, configure, and run Heimdall |
| [Configuration Reference](configuration.md) | Every env var and config key |
| [Lane Management](lane-management.md) | Declare lanes, health states, overrides |
| [Routing Strategies](routing.md) | Pluggable strategies, A/B testing |
| [API Reference](api-reference.md) | HTTP, MCP, and CLI surfaces |
| [Operations Guide](operations.md) | Production, logging, metrics, autopilot |
| [Troubleshooting](troubleshooting.md) | Common failures, diagnostics |

## Background reading

- [Architecture](architecture.md) — component diagram and internal flow
- [Vision](vision.md) — trajectory and roadmap
- [Role & Actuation](heimdall-role-and-actuation.md) — exactly what Heimdall controls
- [Decision records](decisions/) — ADRs for key design choices

## What is a lane?

A *lane* is a `provider × account × runtime` triple — `claude@mathew.dostal`, `codex`, `gemini-2-pro`, `openrouter/grok`, `ollama-local` — each backed by its own long-lived credential. Heimdall's job is to know which lanes are healthy and to act on that knowledge.

Heimdall runs as a headless Node.js service on **`http://localhost:4870`** (override with `PORT`). Sibling gods: **Auriga** (router/orchestrator, consumes `GET /available-route` / `POST /route`), **Vesta** (config), **Portunus** (secrets — future).
