# DEC-hdl-portunus-deferral

**Status:** Superseded — deferral fully lifted (2026-09-07). Both halves of
the prerequisite this decision named now exist and are shipped: Pantheon
Core's cross-god secrets facade (PANT-13/PANT-47) and Heimdall's own
`PantheonSecretCredentialSource` (PR #84, merged 2026-08-29, ahead of this
update — see "Deferral lifted" below for the corrected, current record).

## Decision

Heimdall does **not** integrate directly with Portunus (`mdostal/portunus`), the
Pantheon-ecosystem secrets broker/vault. Standalone mode continues to use a local,
gitignored `.env` file exactly as it does today — unchanged, no new code. Plugin-mode
secret resolution (Heimdall running as a Pantheon god rather than standalone) is
explicitly **deferred** until Pantheon Core ships a cross-god request/response
mechanism to build it against. Heimdall's own L2 service descriptor is registered in
`pantheon-v2`'s `pantheon.gods.yaml` (`capabilities`, `health_endpoint`, `api_version`,
`port`, `transport` — mirroring the pattern `pantheon-v2` PR #73 established for
Portunus) so Heimdall is discoverable once that mechanism exists, but no code in this
repo calls Portunus, and none is planned until the prerequisite below is met.

## Why

Operator directive (2026-08-13, verbatim): *"no plugin should be directly implementing
another plugin -.- this is why things broke -- the pantheon with the L2 lifecycle stuff
and the communication between should be done THROUGH the pantheon and we should focus
on that -- an event should rise from the pantheon for a secret, heimdall would be able
to fetch and inject from portunus etc -- for standalone, no portunus, have a local
fucking .env and just do that, don't overthink shit."*

An orphaned commit (`edda936`, `PAN-5599: bind Portunus secret broker slot`,
2026-07-27, on `origin/recovered/edda936`, never merged to `main`) had already
attempted the rejected shape: a `PortunusCredentialSource` in `credential-source.ts`
that shells out directly to the `portunus` CLI (`portunus resolve "{{secret:NAME}}"`).
That pattern is explicitly superseded by this decision — it is the "plugin directly
implementing another plugin" coupling the operator flagged as the wrong approach and
the source of prior breakage. It is not being revived or updated against current
`credential-source.ts`.

**A dedicated research pass (2026-08-13) confirmed there is currently nothing real to
build a Heimdall→Pantheon→Portunus request/response flow against:**
- Pantheon's L2 descriptor/registry system (`contracts/l2/plugin-descriptor.ts`,
  `service-descriptor.ts`, `lib/gods-adapter.ts`) is real and working — it's
  *discovery* (find where a god lives, what capabilities it claims) via a Zod-validated
  schema fed from `pantheon.gods.yaml`.
- The only real cross-god event flow in `pantheon-v2` today (Consus→Minerva,
  `decision:created`) is one-way, fire-and-forget: the emitter `POST`s to Pantheon
  Core's `/api/events/decisions`, Core delivers to the receiver's webhook URL,
  non-blocking, no reliability guarantees. `pantheon-v2`'s own
  `docs/PANTHEON-CONTRACTS.md` is explicit that this is a notification pattern, not a
  query/response pattern — and that L1's in-process `EventEmitter` bus doesn't even
  reach a god running as its own separate process.
- Neither Heimdall nor Portunus had a real L2 descriptor published as of this decision
  (this doc's own companion PR closes that gap for Heimdall's side — see below).

There is no existing "ask another god for data and get an answer" mechanism in
Pantheon to build a secret-fetch request against. Building one would mean designing
Pantheon Core's cross-god RPC contract from inside a single god repo — explicitly out
of scope ("just heimdall," per the operator's own scoping answer when asked).

## What changed

1. **`pantheon-v2`'s `pantheon.gods.yaml`** — Heimdall's entry gains `capabilities:
   [lane-status, lane-routing, lane-control]`, `health_endpoint:
   "http://127.0.0.1:4870/healthz"`, `api_version: v1`, `port: 4870`, `transport:
   http`. No code changes needed in either repo — Heimdall already has a real, tested
   `GET /healthz` route. Verified directly: ran `loadGodsAsPlugins()` against the
   modified file and confirmed a fully valid `ServiceDescriptor` with zero warnings
   (mirrors `pantheon-v2` PR #73's own verification for Portunus).
2. **This decision record.**

## What this does NOT change

- Nothing about `credential-source.ts`, `lane-registry.ts`, or any credential
  resolution path — Heimdall's standalone-mode `.env` behavior is byte-identical to
  before this decision.
- Nothing about Portunus itself — its own repo, CLI, vault, and UI are unaffected;
  this decision is scoped entirely to whether *Heimdall* calls it, not whether
  Portunus is ready.
- The `hdl-ollama-signals` epic's repurposing of `credential_ref` to carry a base URL
  (for local, unauthenticated providers) is unrelated and unaffected — that's a
  same-repo convention, not a cross-plugin integration.

## Consequences

- Heimdall's plugin-mode UI/interaction surface (`has_ui: true`'s plugin-mode half,
  still unbuilt — see `.pHive/project-profile.yaml`'s notes) will need to account for
  secret resolution being unavailable-by-design until Pantheon Core's request/response
  contract exists. This is a known, accepted gap, not an oversight to silently work
  around.
- Re-opening this decision requires a concrete, real prerequisite: Pantheon Core (the
  `pantheon-v2` host repo) shipping a synchronous or reliably-correlatable cross-god
  request/response mechanism (not the current fire-and-forget notification bus). When
  that exists, the natural next step is a `PantheonSecretCredentialSource` that calls
  through *that* mechanism — discovering Portunus via its L2 descriptor
  (`capabilities: [secret-lookup, secret-injection, ...]`), never a direct CLI/HTTP
  dependency on Portunus's implementation details.
- No timeline is set. This is a "wait for the real thing" deferral, not a scheduled
  follow-up epic.

## Deferral lifted — 2026-09-07 (corrected)

**Epic:** `pantheon-secret-resolution-facade` (PANT-13 through PANT-48)

The prerequisite this decision named — *"Pantheon Core shipping a synchronous
or reliably-correlatable cross-god request/response mechanism"* — now exists,
**and** the Heimdall-side consumer this decision's own Consequences section
anticipated has already been built against it:

- **PANT-13** (`pantheon-core-secrets-facade`): `core/api/secrets.ts` added
  `POST /api/secrets/ask` and `POST /api/secrets/inject` to core-api,
  wrapping Portunus's own file-inject mechanism so gods call only through
  Pantheon Core, never Portunus directly.
- **PANT-47** (`provision-real-multica-runtime-credential`): the Multica
  daemon's own Claude Code operating credential is now provisioned through
  this same facade (pantheon-v2 PR #146). Live-verified 2026-09-03:
  `POST /api/provision/multica-runtime-credential` returns `ok:true` with
  the real credential staged from Portunus; `CLAUDE_CODE_OAUTH_TOKEN`
  confirmed present in the dostal daemon's process environment.
- **Heimdall's own `PantheonSecretCredentialSource`** (this repo, PR #84,
  merged 2026-08-29 — chronologically *before* the PANT-48 live-verification
  above, but not yet reflected in this decision record until now):
  `src/core/pantheon-secret-credential-source.ts` implements the existing
  `CredentialSource` interface, calling only `core/api/secrets.ts` — never
  Portunus directly, exactly the shape this decision's Consequences section
  named. Opt-in only via `HEIMDALL_CREDENTIAL_SOURCE=pantheon`;
  standalone mode's `EnvCredentialSource` default is unchanged. The real
  shared-volume wiring between Portunus's container and wherever this
  credential source runs is tracked separately (pantheon-v2's
  `pantheon-secret-resolution-facade` epic, story C) as a known follow-up,
  not assumed complete by this record.

Both halves of the original deferral — the Pantheon Core mechanism, and
Heimdall's own consumer of it — are real and shipped. Nothing further is
blocked on this decision.
