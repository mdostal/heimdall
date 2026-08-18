---
name: heimdall-models
description: List Heimdall's live per-installation model catalog, refresh it from each configured lane's provider, and enable/disable individual models. Use whenever the user asks "what models can I actually call right now," wants Heimdall to re-check what's available from a provider, or wants to turn a specific model on or off.
---

# Heimdall Models

Three MCP tools under the `heimdall` MCP server (`heimdall.models.*`). The catalog answers
"what models can actually be called right now" — don't hardcode or guess a model name that may
be deprecated; call `heimdall.models.list` instead.

## `heimdall.models.list` — read the catalog

| param      | type   | required | notes                                                             |
|------------|--------|----------|----------------------------------------------------------------------|
| `provider` | string | no       | filter to one provider (e.g. `"gemini"`); omit for the full catalog |

```json
{ "tool": "heimdall.models.list", "arguments": {} }
```

```json
{ "tool": "heimdall.models.list", "arguments": { "provider": "claude" } }
```

Returns an array of catalog entries, each with the model id, provider, and its current
`enabled` state (plus `default_enabled`, the recency-heuristic default before any manual
override).

## `heimdall.models.refresh` — pull each provider's live model list

No parameters. Asynchronous — awaiting the tool call is what waits for it to finish; there's
no separate polling step.

```json
{ "tool": "heimdall.models.refresh", "arguments": {} }
```

```json
{ "providersRefreshed": ["claude", "codex", "gemini"], "modelsSeen": 14 }
```

Only Heimdall's four gated providers are refreshed: `claude`, `codex`, `kimi`, `gemini`.
OpenRouter and Ollama lanes are skipped (OpenRouter routes are already explicit per-lane
declarations; Ollama has no deprecation concept to refresh against). One provider's fetch
failure never aborts the rest of the refresh. **Newly-seen models get a default enabled state
from a recency heuristic; a model you've already called `heimdall.models.setEnabled` on keeps
your choice — refresh never overwrites a prior manual override.**

## `heimdall.models.setEnabled` — enable or disable one model

| param      | type    | required | notes                                    |
|------------|---------|----------|---------------------------------------------|
| `provider` | string  | yes      |                                                |
| `model_id` | string  | yes      |                                                |
| `enabled`  | boolean | yes      |                                                |

```json
{
  "tool": "heimdall.models.setEnabled",
  "arguments": { "provider": "claude", "model_id": "claude-3-5-haiku", "enabled": false }
}
```

This overrides the recency-heuristic default and survives future `heimdall.models.refresh`
calls. There's no bulk form — call it once per `(provider, model_id)` pair you want to change.
