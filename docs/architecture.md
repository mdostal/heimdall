# Heimdall Architecture

Heimdall is the **health-aware lane gateway and router** for Pantheon. It senses lane health from layered signals, routes tasks to the best healthy lane, and actuates by toggling Multica agent concurrency.

## Component & Flow Diagram

```mermaid
flowchart TB
    subgraph Pantheon
        Auriga["Auriga (router / orchestrator)"]
        Vesta["Vesta (config)"]
        Portunus["Portunus (secrets — future)"]
        Argus["Argus (OTEL dashboard — one of several possible consumers)"]
    end

    subgraph Heimdall["Heimdall service (:4870)"]
        direction TB
        Reg["Lane Registry\n(env-declared lanes)"]
        Sched["Schedulers\nMulticaAutopilot (coarse cron)\nInProcess (~5s, suspect lanes)"]
        Pipe["Lane Pipeline\n(per-lane sense loop)"]
        subgraph Signals["Signal sources (layered)"]
            Passive["passive\n(observed traffic)"]
            Public["public_status\n(provider status page)"]
            Probe["active_probe\n(cheap real call)"]
        end
        Model["status-model\n(4-state resolve +\ncorroboration)"]
        Store["State Store\n(node:sqlite)"]
        Route["Route Selector\n(pluggable strategy:\npriority | round-robin | scored | off)"]
        Rotate["RotationController\n(2+ lanes/provider,\ncap-signal failover)"]
        Ctrl["ControlAdapter\nMulticaControlAdapter | StubControlAdapter"]
        Telemetry["Local telemetry\n(telemetry_events + GET /metrics)"]
        API["Query surfaces\nHTTP · CLI · MCP · Dashboard"]
    end

    Multica["Multica REST API\n(agents / runtimes)"]

    Vesta -. lane + agent config .-> Reg
    Portunus -. tokens (future) .-> Reg
    Sched --> Pipe
    Pipe --> Signals
    Signals --> Model
    Model --> Store
    Store --> API
    Store --> Route
    Route --> API
    Store --> Rotate
    Rotate --> API
    Store --> Ctrl
    Ctrl -->|max_concurrent_tasks 0/N| Multica
    Ctrl -. actuation results .-> Telemetry
    Rotate -. rotation events .-> Telemetry
    Route -. model substitutions .-> Telemetry
    Telemetry --> API
    Auriga -->|GET /available-route, POST /route| API
    Sched -. cron trigger .-> Multica
    Multica -. POST /lanes/:id/refresh .-> API
    API -. GET /metrics, scrape .-> Argus
```

## Internal Loop

1. **Schedulers** tick a lane.
2. The **lane pipeline** gathers layered **signals** (passive observation, provider status-page piggybacking, sparse active probes).
3. **status-model** resolves them into one of four states with a corroboration guard against provider false-positives.
4. The result is persisted to the **SQLite state store**.
5. The shared status-watcher calls the lane's **ControlAdapter** to reconcile Multica agent concurrency.
6. On a routing request, the **route selector** picks a healthy, override-aware lane via the active pluggable strategy; the **scored** strategy also records a decision to its ledger and accepts an outcome report back.
7. For providers with 2+ credentialed lanes, **RotationController** detects cap signals and can fail over to the next healthy account.

Every actuation result, rotation event, and model substitution is recorded **locally first** (`telemetry_events`, exposed via `GET /metrics`) — Argus is one optional downstream consumer of the same facts, not the source of truth.

## Metrics, Toggles & A/B Testing
Per the Pantheon OSS standard, Heimdall supports:
- **Toggles:** Every lane can be toggled on/off dynamically (`manual_override`, health-based actuation). The active routing strategy itself is toggleable via `GET`/`POST /routing-strategy`, including an explicit `off` state.
- **A/B Testing:** The `scored` routing strategy assigns deterministic experiment arms from `config/routing-policy.yaml` and records every decision + reported outcome to a local ledger — the actual A/B mechanism, not lane-concurrency weighting.
- **Metrics:** Heimdall keeps its own local record of everything it does (`GET /metrics`, Prometheus text format) — self-contained, independent of any external collector. Argus, Grafana, Prometheus, or anything else OTEL/Prometheus-compatible can scrape it later without Heimdall depending on any of them being present.
