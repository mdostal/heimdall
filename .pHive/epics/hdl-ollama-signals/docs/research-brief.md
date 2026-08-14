# Research Brief — hdl-ollama-signals

## Operator decision (2026-08-13)

Resolves the Ollama half of the design-options artifact presented alongside OpenRouter's
decision — verbatim: *"liveliness it doesn't really have a path -- it should have liveliness
so we can signal off of it mostly."* Confirms Option A (minimal liveness-only adapter) over
Option B (skip entirely), and confirms the artifact's own finding that no degraded/out_of_credit
path applies — liveness (up/down) is the whole signal.

## Ollama's actual signal surface (confirmed in the earlier design-options research pass)

- `GET /` → plain text `"Ollama is running"` when the local daemon is up. No auth, no JSON.
- `GET /api/tags` → lists locally-installed models, still unauthenticated. This is the better
  probe target — it proves the actual Ollama API is answering correctly (JSON, real endpoint
  behavior), not just that something is listening on the port.
- No credential, no quota, no rate limit, no billing state — confirmed no `degraded` or
  `out_of_credit` signal exists for local inference.
- No public status page — it isn't a hosted service.

## Design simplification found during implementation research

The original artifact framed Option A as needing `Lane.credential` to become optional "for
this one provider" — a real touch to `lane-registry.ts`'s validation, `route-selector.ts`'s
`credential !== null` candidacy filter, and `lane-pipeline.ts`'s `refreshViaProbe` unconfigured
short-circuit (all three currently assume every provider needs a resolvable secret).

**A cleaner path was found that needs none of that.** `credential_ref` is already a pure
indirection — "the env var NAME that configures this lane's connection" — not intrinsically
tied to being a *secret*. Ollama has no secret, but it DOES have something else that varies
per-lane and needs configuring: which host/port to reach (default `localhost:11434`, but an
operator adding a dedicated GPU box per north_star's `expected_scale` — "scales... as
hardware/instances are added" — needs a different host per Ollama instance). Declaring
`HEIMDALL_LANE_<N>_CREDENTIAL_REF=OLLAMA_HOST` with `OLLAMA_HOST=http://localhost:11434` in
`.env` makes `EnvCredentialSource.resolve()` return that URL as `lane.credential` through the
existing, unmodified pipeline — `credential !== null` candidacy, `refreshViaProbe`'s
unconfigured guard, and `store.upsertLane`'s `credential_ref TEXT NOT NULL` column all already
handle this with **zero code changes**. The "credential" is repurposed to carry a base URL
instead of a secret — a documented convention, not a schema change.

This means hdl-ollama-signals is a smaller epic than the artifact originally anticipated: one
new adapter (mirroring the established factory pattern) plus wiring, no touches to
`lane-registry.ts`, `route-selector.ts`, or `lane-pipeline.ts`'s credential-gating logic at all.

## Sources

- Design-options artifact research (2026-08-13): Ollama `GET /` and `GET /api/tags` API
  reference, no-auth confirmation.
- `src/core/credential-source.ts` — confirms `EnvCredentialSource.resolve()` returns any
  non-empty string value verbatim, with no assumption about its content being a secret.
