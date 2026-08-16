# Design Discussion — hdl-desktop-app

## 0. Prelude

Operator (2026-08-16), after `hdl-error-taxonomy` and `hdl-docs-viewer` shipped:
*"cool, just like portunus and the rest, let's get this into a standalone app,
test it out and even give it an install and setup to go on an single point of
install by itself so we can see and navigate the docs and work with the
diagrams etc -- once i can do that, we are fully dogfooding this and i can
lock it down."*

The reference is explicit: Portunus's own real, shipped Tauri v2 desktop app.
Two research passes preceded any code: (1) read Portunus's actual
implementation in full (`sidecar.rs`, `lib.rs`, `tray.rs`, `updater.rs`,
`Cargo.toml`, `tauri.conf.json`, `build-resources.sh`,
`resources/relauncher.sh`, `.github/workflows/release-desktop.yml`) — its own
CHANGELOG entries describe live-tested behaviors ("verified live with a
deliberately corrupted download," "verified against the actual Apple Event
quit path"), confirming this is a real working pattern, not aspirational; (2)
confirmed no shared cross-god desktop-app template exists in the Pantheon
ecosystem — Portunus's implementation is the only reference, and adapting it
for Heimdall requires genuine rewrites, not a blind copy.

## 1. What transfers unchanged vs. what needs real adaptation

Byte-identical (fully generic Tauri boilerplate): `build.rs`, `src/main.rs`,
`capabilities/default.json`. Adapted with only naming/branding changes:
`lib.rs`, `tray.rs`, `updater.rs`, `resources/relauncher.sh`.

Genuinely rewritten, not adapted:

- **`sidecar.rs`** — Portunus hardcodes Next.js `standalone/server.js`
  resolution; Heimdall has no separate frontend build. Heimdall's own Node
  process serves the dashboard/docs-viewer directly, so the sidecar just
  spawns `node dist/src/main.js` with the right env wired in.
- **`build-resources.sh`** — Portunus's Next.js `standalone` output
  self-bundles its own npm dependencies; Heimdall's plain `tsc` output does
  not. Runtime deps are staged via a clean `npm ci --omit=dev` *inside* the
  staging directory, never touching the live checkout's own `node_modules`
  (which still needs its devDependencies for `npm test`/`npm run build` to
  keep working in the normal dev workflow).
- **`Cargo.toml` / `tauri.conf.json`** — new bundle identifier
  (`com.mdostal.heimdall`), product name, repo, and asset naming
  (`heimdall-desktop-*.zip`, matching the real convention confirmed in
  Portunus's own release workflow).
- **`dist-placeholder/index.html`** — no reference exists (Portunus's own
  checkout doesn't have this file tracked either); authored from scratch.
- **Icons** — generated via Python PIL (a placeholder rounded-square mark)
  piped through `cargo tauri icon` for the full required set.

## 2. Runtime wiring: where `.env`, the DB, and docs live

Confirmed by reading `main.ts`/`http-server.ts` directly (not assumed):
`createHttpServer`'s `envFilePath` param defaults to `.env`, resolved
relative to `process.cwd()` — and `main.ts`'s own call passes `undefined`,
so it always uses that default. This means the sidecar's `current_dir` IS
the effective `.env` location for both the Node startup flag
(`--env-file-if-exists=.env`) and the add-lane HTTP write path — they only
agree if cwd is set consistently, which `sidecar.rs` does by pointing cwd at
a stable per-user app-data directory
(`~/Library/Application Support/com.mdostal.heimdall`) rather than wherever
the `.app` bundle happens to be installed (which must survive app updates,
where the bundle itself gets replaced).

`HEIMDALL_DB_PATH` is set to an absolute path inside that same app-data
directory, so the SQLite state survives across restarts and updates.
`HEIMDALL_REPO_ROOT` — the override added specifically for this purpose in
the immediately-prior `hdl-docs-viewer` epic — is set to the bundled
resource root (`resources/heimdall/`, containing `docs/`), so the docs
viewer finds real doc files instead of resolving against the app-data cwd.

## 3. Real bug found and fixed during live verification

The first draft (matching Portunus's own pattern) handled sidecar cleanup
only on `RunEvent::ExitRequested`, in the one `builder.run()` callback.
Live-testing the actual quit path (`cargo tauri dev`, real Cmd+Q via a
simulated keystroke, not just reading the code) showed the sidecar `node`
process survived the app quitting — confirmed via `ps`, not assumed. Added
diagnostics and found the real cause: this build/platform configuration
delivers `RunEvent::Exit` directly on Cmd+Q, with **no** preceding
`ExitRequested`. Fixed by handling cleanup on both variants (`kill_sidecar`
is naturally idempotent via `Option::take()`, so no double-kill risk).
Re-verified live: both the app and the sidecar now exit cleanly.

## 4. What "test it out" actually covered

Not just `cargo build` succeeding — a real `cargo tauri dev` launch was
confirmed via `ps`/`lsof` to spawn the sidecar, bind a real port, and pass
`/healthz`. The actual native window was screenshotted showing the live
dashboard (not the loading placeholder), confirming the health-check-then-
navigate flow works. `/lanes`, `/docs`, `/docs/architecture`, and
`/vendor/mermaid.min.js` were curled directly against the spawned sidecar's
port and all returned 200 — the docs+diagrams browsing the operator
specifically asked for is reachable through the packaged app. The SQLite DB
file was confirmed created at the correct macOS `Application Support` path.
The quit path was verified twice (buggy, then fixed) via real Cmd+Q.

Not yet done: a full `cargo tauri build` (ad-hoc signed `.app` bundle) and
installing/running that bundle standalone (outside `cargo tauri dev`'s
watch-mode wrapper) — `cargo tauri dev` proves the runtime wiring is
correct, but the release-mode bundle path (resource resolution via
`resource_dir()` inside a real `.app`, not the dev-mode repo-checkout
fallback) has not itself been exercised live. Left as an explicit follow-up
rather than silently claimed as covered.
