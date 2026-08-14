# Design Discussion — hdl-ollama-signals

## 0. Prelude

**NORTH STAR**: Ollama is the sixth and last named provider. After this epic, all 6 north-star
providers (Claude, Codex, Gemini, OpenRouter, Kimi K3, Ollama) have real signal adapters.

**OPERATOR DECISION** (verbatim, resolving the Ollama half of the design-options artifact):
*"liveliness it doesn't really have a path -- it should have liveliness so we can signal off of
it mostly."*

## 1. Goal

A minimal liveness-only adapter for Ollama: up/down, nothing else — confirmed by research that
no other state (degraded/out_of_credit) has a real signal to drive it for local inference.

## 2. Proposed approach

`active-probe/ollama.ts`: `GET <baseUrl>/api/tags`, no auth. `baseUrl` comes through the
existing `credential` parameter every `probe()` function already receives — repurposed to
carry a base URL instead of a secret (see research-brief.md's design simplification). If the
value looks like a URL (`http://`/`https://` prefix), use it directly; otherwise (including the
default empty-string case when a lane declares no credential_ref at all) fall back to
`http://localhost:11434`. 200 + parseable JSON → `up`. Any failure (network error, non-200,
unparseable body) → `down`. No `reset_at`, no `degraded`, no `out_of_credit` — there is nothing
in Ollama's local, unauthenticated surface that would produce those states honestly.

No `public-status/ollama.ts` — it's local infra, not a hosted service; no status page exists.
`checkPublicStatus` is the same honest always-up stub `openrouterAdapters()` already
established a precedent for.

Wiring: `ollamaAdapters(): ProviderAdapters` + one `PROVIDER_ADAPTERS` line, identical shape to
every prior provider epic.

## 3. Resolved open questions

1. **Does this need `Lane.credential` to become optional?** No — a cleaner path was found
   during implementation research: an operator declares
   `HEIMDALL_LANE_<N>_CREDENTIAL_REF=OLLAMA_HOST` pointing at an env var holding the Ollama
   instance's base URL (e.g. `OLLAMA_HOST=http://localhost:11434`, or a remote workstation's
   address for a dedicated GPU box). This flows through the existing, completely unmodified
   credential-resolution/candidacy pipeline — `lane-registry.ts`, `route-selector.ts`, and
   `lane-pipeline.ts`'s unconfigured-guard all work as-is. Zero schema or candidacy-gate
   changes, a smaller epic than the original artifact anticipated.
2. **Per-instance host configuration?** Supported for free by the above — each Ollama lane can
   point at a different host via its own `credential_ref`-indirected env var, serving
   north_star's "scales... as hardware/instances are added" without any new declaration field.

## 4. Risks

| Risk | Mitigation |
|---|---|
| "credential_ref" now sometimes means "base URL," not "secret" — a naming/semantic stretch | Documented explicitly in-file and in this design doc; the field's actual contract ("names an env var, resolved verbatim") already supported this without change. |
| An operator omits the credential_ref entirely for an Ollama lane, expecting a bare default | `lane.credential` would be `null` in that case — same "unconfigured" path every other provider already has (REQ-07). Documented: an Ollama lane needs its `credential_ref` set (even to a placeholder value) to be a routing candidate at all, same requirement every other provider already has. |

## 5. Scale assessment

**Small** — one new adapter mirroring an established pattern, one wiring line, zero touches to
shared/provider-agnostic code. Proceeding directly to stories.
