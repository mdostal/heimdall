# Design Discussion — hdl-desktop-icon-settings

## 0. Why this is a separate epic

`hdl-unified-dashboard` shipped `GET`/`POST /desktop-icon` on the Node
side because it's the same small settings-table pattern as `/theme` and
belongs in the same Settings panel UI. This epic is everything that
required actually researching and touching the Rust/Tauri side, kept
separate rather than inflating an already-large epic further.

## 1. Rasterizing the mockups, and a real bug found doing it

Playwright's own screenshot tool was non-functional in this sandboxed
environment (confirmed across multiple attempts, even on `about:blank` —
an environment limitation, not specific to these files). Worked around it
by calling `canvas.toDataURL('image/png')` via `page.evaluate()` with the
result saved straight to a file, then decoding the base64 payload with
Python — avoiding the broken screenshot pipeline entirely while still
getting real, pixel-accurate PNGs.

Doing this surfaced a real composition bug in the Signal Horn concept:
the motif was crammed into the bottom-right quadrant, with the outer
signal arc actually clipped off the canvas edge — confirmed by looking at
the decoded PNG, not by reading the drawing code (which read as
reasonable on its own). The original agent's own report had already
hinted at the risk: it noted Playwright's screenshot tool was
non-functional for it too and that it had verified via pixel sampling
instead — meaning it never actually saw its own rendered output. A
dedicated fix agent was given the bug already confirmed (exact
bounding-box measurements, not "please double check"), told to change
ONLY positioning math (no color/shape/style), and told to verify with the
same pixel-measurement technique before/after. It reported a fix; that
report was itself independently re-verified with a fresh render rather
than trusted at face value — a second server hiccup during that
re-verification produced a stale/cached render that looked unfixed,
which could easily have been mistaken for the fix failing. Restarting the
server and reloading confirmed the fix was real.

## 2. Tray icon Rust API, researched not guessed

Initial assumption was that setting a tray icon would require the raw
`tray_icon` crate's own `Icon::from_rgba` (since `Icon::from_path` is
`#[cfg(windows)]`-only in that crate, confirmed by reading its actual
source in the local Cargo registry cache). Further reading of Tauri's own
source found `tauri::tray::TrayIcon::set_icon` takes a
`tauri::image::Image` directly — `tauri::image::Image::from_path` decodes
PNG cross-platform (behind the `image-png` feature, added to `Cargo.toml`)
and needs no conversion into the raw `tray_icon` crate's own type at all.
Simpler than the original plan, found by reading the actual dependency
source rather than assuming the more complicated path was necessary.

The tray itself needed an explicit id (`TrayIconBuilder::with_id("main")`
instead of `::new()`) because there is no `AppHandle::tray()` default-
lookup shortcut — `tray_by_id` is the only retrieval path, confirmed by
reading `tauri::App`'s own method list.

## 3. Real, confirmed platform limit — and a copy correction

Already established during `hdl-unified-dashboard`'s own research: no
supported way to swap the Dock icon at runtime on macOS with Tauri v2
(multiple open Tauri GitHub issues). Only the tray icon updates from this
code, and only once, at startup (the preference is fetched once in the
post-health-check thread, never polled) — meaning a change made through
the Settings panel while Heimdall is already running takes effect on the
*next* launch, not immediately. The first draft of the Settings panel copy
("Tray icon preference saved") didn't make that timing clear and read as
implying an instant update. Corrected to: "Preference saved. Tray icon
updates next time you launch Heimdall; Dock icon needs a rebuild: cd app
&& cargo tauri build" — accurate about both halves of the real behavior.

## 4. Live verification

Confirmed via `cargo tauri dev`'s real stdout (temporary diagnostic
`eprintln!`s at each step, removed before shipping, matching the same
technique that caught the earlier Cmd+Q sidecar-orphaning bug): fetch
`/desktop-icon` → resolve the bundled path → load the image → `set_icon`
all succeeded end to end against the real running app, not just "the code
compiles and the types line up."
