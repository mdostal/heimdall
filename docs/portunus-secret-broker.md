# Portunus Secret Broker Slot

Heimdall treats `credential_ref` as a reference, never as a secret value.
Plain refs keep the original local env stopgap:

```env
HEIMDALL_LANE_1_CREDENTIAL_REF=CLAUDE_TOKEN
CLAUDE_TOKEN=...
```

Brokered refs use Portunus' current CLI boundary:

```env
HEIMDALL_SECRET_BROKER=portunus
HEIMDALL_LANE_1_CREDENTIAL_REF=portunus:shared-anthropic
HEIMDALL_LANE_1_CREDENTIAL_SCOPE=shared
```

`credential_scope` is host-side metadata for the scoped broker contract. The
Portunus CLI resolves by reference name today; Portunus' own registry entry
carries the authoritative scope, kind, lifecycle state, and approval gate.

## Boundary

Heimdall invokes:

```bash
portunus resolve "{{secret:shared-anthropic}}"
```

Portunus prints a temporary `0600` file path, never the value. Heimdall reads
that file at the provider-call boundary and deletes it immediately. Do not log
resolved lane credentials, request headers, or the temp-file path.

## Local Stopgap

If `HEIMDALL_SECRET_BROKER=portunus` is set but the Portunus CLI is absent or
denies resolution, Heimdall falls back to a local env var named from the
Portunus reference:

```env
HEIMDALL_LANE_1_CREDENTIAL_REF=portunus:shared-anthropic
HEIMDALL_LOCAL_SECRET_SHARED_ANTHROPIC=...
```

That fallback is intentionally documented and explicit. It exists only so local
Heimdall can keep sensing lanes before Portunus is installed; production
Pantheon mode should register the ref in Portunus and leave the local fallback
unset.
