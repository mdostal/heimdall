---
title: Configuration Reference
nav_order: 3
---

# Configuration Reference
{: .no_toc }

All configuration is via environment variables loaded from `.env` at startup. No config files are parsed; no flags are required beyond what the env provides.

<details open markdown="block">
  <summary>Table of contents</summary>
  {: .text-delta }
1. TOC
{:toc}
</details>

## Lane declaration

Lanes are declared as **contiguous numbered triples** starting at 1. Loading stops at the first missing `HEIMDALL_LANE_<N>_ID`.

| Variable | Required | Description |
|---|---|---|
| `HEIMDALL_LANE_<N>_ID` | Yes | Unique lane identifier. Convention: `provider@account` (e.g. `claude@mathew.dostal`). |
| `HEIMDALL_LANE_<N>_PROVIDER` | Yes | Provider name: `claude`, `codex`, `gemini`, `kimi`, `openrouter`, `ollama`. |
| `HEIMDALL_LANE_<N>_MODEL` | Yes | Model identifier (e.g. `claude-sonnet`, `gpt-codex`, `gemini-2-pro`). |
| `HEIMDALL_LANE_<N>_CREDENTIAL_REF` | Yes | Name of *another* env var that holds the actual secret. The indirection keeps secrets out of lane declarations. |
| `HEIMDALL_LANE_<N>_HEADROOM` | No | Scoring input — estimated remaining token budget. Default: `10000`. |
| `HEIMDALL_LANE_<N>_COST_TIER` | No | `low` \| `medium` \| `high`. Used by the scored strategy. Default: `medium`. |
| `HEIMDALL_LANE_<N>_PRIORITY` | No | Integer rank for the priority strategy. Lower = higher priority. Unset = treated as last. |
| `HEIMDALL_LANE_<N>_MULTICA_AGENT_IDS` | No | Comma-separated Multica agent IDs bound to this lane. Reported on `GET /lanes` for downstream actuators. |

### Example

```dotenv
HEIMDALL_LANE_1_ID=claude@primary
HEIMDALL_LANE_1_PROVIDER=claude
HEIMDALL_LANE_1_MODEL=claude-opus
HEIMDALL_LANE_1_CREDENTIAL_REF=CLAUDE_PRIMARY_TOKEN
HEIMDALL_LANE_1_HEADROOM=50000
HEIMDALL_LANE_1_COST_TIER=high
HEIMDALL_LANE_1_MULTICA_AGENT_IDS=abc123,def456
CLAUDE_PRIMARY_TOKEN=sk-ant-...

HEIMDALL_LANE_2_ID=claude@secondary
HEIMDALL_LANE_2_PROVIDER=claude
HEIMDALL_LANE_2_MODEL=claude-sonnet
HEIMDALL_LANE_2_CREDENTIAL_REF=CLAUDE_SECONDARY_TOKEN
CLAUDE_SECONDARY_TOKEN=sk-ant-...

HEIMDALL_LANE_3_ID=ollama-local
HEIMDALL_LANE_3_PROVIDER=ollama
HEIMDALL_LANE_3_MODEL=llama3
HEIMDALL_LANE_3_CREDENTIAL_REF=OLLAMA_DUMMY
OLLAMA_DUMMY=local
```

## Service settings

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4870` | HTTP server port. |
| `HEIMDALL_DB_PATH` | `~/.local/share/heimdall/heimdall.db` | SQLite state store path. Set to `:memory:` for ephemeral (tests only). |
| `HEIMDALL_RETENTION_DAYS` | `30` | Days of `lane_status_history` and `telemetry_events` to keep. Older rows are pruned at startup and daily; each lane's latest status row is always kept. Non-positive or non-numeric values fall back to the default. |
| `HEIMDALL_HOME` | `~/.heimdall` | Root directory for Heimdall local state (token registry, etc). |
| `HEIMDALL_TOKEN_REGISTRY_PATH` | `$HEIMDALL_HOME/token-registry.json` | Path to the multi-account token registry file. |
| `HEIMDALL_CODEX_HOME_ROOT` | `$HEIMDALL_HOME/codex` | Where Heimdall keeps its own `CODEX_HOME` for each ChatGPT-login codex lane. Put it on a persistent volume. See [Codex credentials](#codex-credentials). |
| `HEIMDALL_SIGNAL_STALE_MULTIPLIER` | `3` | A lane's `signal_state` becomes `stale` when its last observation is older than this many × its expected probe interval (PANT-823). With the default 5-minute interval that is 15 min. |
| `HEIMDALL_READINESS_STALENESS_MS` | `900000` (15 min) | `GET /readyz` reports `degraded` if no lane has been observed within this window. |

## Multica integration

| Variable | Required | Description |
|---|---|---|
| `MULTICA_AUTOPILOT_AGENT` | No (opt-in) | Enables Multica-autopilot scheduling: the agent ID dispatched when a lane's coarse-cron autopilot fires. Each trigger dispatches a full agent (LLM) session and spends quota — leave unset to rely on in-process probing only (the default). |

## Argus / OTEL telemetry

| Variable | Default | Description |
|---|---|---|
| `ARGUS_OTLP_PROTOCOL` | `grpc` | `grpc` or `http`. |
| `ARGUS_OTLP_HOST` | `localhost` | OTEL collector host. |
| `ARGUS_OTLP_GRPC_PORT` | `4327` | gRPC collector port. |
| `ARGUS_OTLP_HTTP_PORT` | `4328` | HTTP collector port. |

Heimdall emits spans and metrics to this endpoint. If no collector is reachable, telemetry is silently dropped — the service continues operating.

## OpenRouter sub-routes

OpenRouter lanes nest multiple independently-toggled routes under one credential. Declare with `HEIMDALL_LANE_<N>_PROVIDER=openrouter`. The lane's `MODEL` is the OpenRouter model slug. Each OpenRouter lane is a separate entry in the registry — they share no state.

## Codex credentials

A `codex` lane's credential can take one of two shapes. Heimdall picks the probe from the shape:

| Credential | How it is probed |
|---|---|
| OpenAI Platform API key (`sk-...`) | `GET https://api.openai.com/v1/models`. Free. |
| A full Codex CLI `auth.json` (JSON with `tokens.id_token`, `access_token`, `refresh_token`) | Runs the real `codex` CLI: `codex exec --ephemeral "reply with the single word OK"`. It spends a small amount of inference, like Claude subscription lanes. |

A bare ChatGPT access token (`eyJ...`) is reported `down`/`auth_failed` without making a network call. `api.openai.com` rejects it (403 `Missing scopes: api.model.read`), and the CLI can't run on it without the id and refresh tokens.

**Give Heimdall its own login.** Codex refreshes the session in `auth.json` itself, and each refresh token can be used once. If Heimdall's probe and another runtime (for example Multica's codex agents) share one session, whichever refreshes second fails with `refresh token was already used`. Create a separate session for Heimdall and vault that file:

```bash
CODEX_HOME="$(mktemp -d)" codex login --device-auth
jq -c . "$CODEX_HOME/auth.json"   # store this one line as the lane's secret, then delete the directory
```

Store it on one line: `HEIMDALL_CREDENTIAL_SOURCE=pantheon` reads the secret back from a `VALUE=<secret>` line.

Never store a copy of another runtime's `~/.codex/auth.json`.

Heimdall writes the seed once to `$HEIMDALL_CODEX_HOME_ROOT/<hash of seed>/auth.json` (mode 600). After that the CLI owns the file and keeps its refreshed tokens there. Probes of one session run one at a time. A new seed (a new login) gets a new directory. If that directory is lost, the original seed is written again, and its refresh token may already have been spent. The lane then reports `auth_failed` with a re-provision hint until you vault a fresh login.

The `codex` CLI must be on `PATH` (`npm install -g @openai/codex`).

## Credential security

- Credentials are stored in `.env` on disk, never returned by any Heimdall API.
- The `credential_ref` indirection means lane IDs (logged, reported) never contain the secret itself.
- `HEIMDALL_TOKEN_REGISTRY_PATH` is chmod 600 by `scripts/setup-token-registry.sh`.
- Never commit `.env` — it is in `.gitignore`.
