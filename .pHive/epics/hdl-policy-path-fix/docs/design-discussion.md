# Design Discussion — hdl-policy-path-fix

## 0. How this was found

Operator asked to keep the real desktop app installed at `/Applications/
Heimdall.app` for actual day-to-day dogfooding. Before leaving it there,
rebuilt from the latest `dev` (which now includes `hdl-routing-policy-
dashboard`, not present in the build tested during `hdl-desktop-app`
itself) and re-ran the same live verification pattern used throughout this
session: curl every panel's endpoint through the real installed app, not
just assume a rebuild is safe because the test suite passes.

`GET /routing-policy` returned `503 policy_unavailable`, `ENOENT` against
`~/Library/Application Support/com.mdostal.heimdall/config/routing-
policy.yaml` — a path that never existed, because `PolicyLoader`'s default
path is `join(process.cwd(), "config", "routing-policy.yaml")`, and the
desktop app's sidecar (by design, from `hdl-desktop-app`) sets cwd to that
app-data directory so `.env`/DB persistence works. Two independently
correct pieces of work combined into a real defect neither one alone would
have produced — the kind of interaction the test suite, scoped to each
epic individually, had no way to catch.

## 1. Scope of the actual bug

Not just the new dashboard panel. `ScoredStrategy` also calls
`PolicyLoader.load()` with no path override (confirmed by reading
`scored-strategy.ts`: `PolicyLoader.load(this.options.policyPath)` where
`policyPath` is `undefined` at every real call site). If the `scored`
routing strategy were ever activated inside the desktop app, route
selection itself would silently fail to find the policy file — this fix
closes a real routing-correctness gap, not just a dashboard display bug.

## 2. Fix

Two parts, both needed — path resolution alone wasn't sufficient because
the file didn't physically exist in the bundle either:

1. **`policy-loader.ts`**: `HEIMDALL_REPO_ROOT` now takes precedence over
   `process.cwd()` for the default policy path, mirroring the exact
   precedent `http-server.ts`'s `docsRepoRoot` already established for the
   identical class of problem (`hdl-docs-viewer`). Factored into a pure
   `resolveDefaultPolicyPath(env, cwd)` function rather than left inline in
   the module-level constant, specifically so the precedence is
   unit-testable — the original inline form couldn't be regression-tested
   since `process.env` is read once at module-import time and a test can't
   observe it changing after the fact.
2. **`build-resources.sh`**: now also stages `config/` into the bundled
   resource directory alongside `docs/` — it was never copied at all.

## 3. Verification

Rebuilt the real ad-hoc-signed `.app`, reinstalled it to `/Applications`,
and curled `/routing-policy` through the running installed app — confirmed
the real policy data now returns correctly. No automated test can exercise
"the packaged app's actual cwd," so this class of bug needs exactly this
kind of live, installed-app verification going forward, not just the unit
test suite (which does now cover the pure path-precedence logic itself).
