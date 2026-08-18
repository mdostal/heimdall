# Design Discussion — hdl-icon-reconciliation

## 0. What actually happened (written after the fact — see §1 for why)

Operator, after `hdl-desktop-icon-settings` shipped: *"Use the actual icons we saw, but looks good overall need to do the full /hive plan and execute for it, not one off work."*

This epic's first pass investigated the wrong problem. Research correctly refuted a macOS icon-cache staleness theory (real live testing: force-cleared the cache, no change) but then, on top of that, an adversarial review pass found a real-looking bug — the Watchtower icon's crenellations are drawn in a color matching the tower's own shadow gradient, invisible at any size, and gated off entirely below 128px — and the plan escalated into "redesign the icon's small-size legibility." That framing was wrong. The operator, shown a screenshot of the icon-picker UI itself (not the icon artwork), pointed out plainly: *"THESE are NOT the icons you showed me"* — and separately, after being shown the actual published Artifact's real-size renders, confirmed directly: *"ALL 3 look fine at 16 in the prior things done."* The cone/beacon/arc rendering is exactly what was approved and is not a defect. The whole crenellation-contrast investigation was solving a problem that doesn't exist, while missing the real one.

**The real bug**, once correctly identified: the Settings-panel icon picker (`hdl-unified-dashboard`) rendered each option as a generic Unicode emoji (🗼 🔀 📯) — quick placeholder labels chosen when that panel was first built, never replaced with the actual designed artwork. The operator, looking at the Settings page, saw three emoji that don't resemble Watchtower/Routing Mark/Signal Horn at all and reasonably read that as "these aren't the icons I approved" — because they genuinely weren't.

## 1. Why this document says so directly

This session's own established discipline is to document real findings, including wrong turns, rather than launder them into a clean narrative after the fact. The wrong-turn cost real time and, more importantly, real frustration — worth stating plainly so it doesn't repeat: when an operator says "these aren't the icons," the fastest and most respectful next step is to ask *where* they're looking, not to build a research pipeline around an assumption of where they might be looking.

## 2. Actual root cause

`dashboard.ts`'s icon-picker `<button>` markup used a hardcoded `ICON_GLYPHS` lookup table of Unicode emoji instead of the real per-icon artwork. No route existed to serve the actual icon-set PNGs to the browser at all — the icon files only ever lived inside the Tauri-bundled resource tree (`resources/icon-sets/`) or the git checkout, neither reachable by the Node HTTP server's existing static-asset patterns (`docsRepoRoot`/`HEIMDALL_REPO_ROOT` points at a *sibling* Tauri resource directory, not this one — confirmed by reading `tauri.conf.json`'s `bundle.resources` mapping, where `resources/heimdall` and `resources/icon-sets` both map directly under `Resources/`, neither nested inside the other).

## 3. Fix

1. New `GET /desktop-icon/:name/thumbnail.png` route, validated against the existing `DESKTOP_ICONS` allowlist before touching the filesystem (same discipline as the docs viewer's `:slug` handling — never resolve an arbitrary caller-supplied path). Serves the real `128x128.png` from each icon set.
2. New `HEIMDALL_ICON_SETS_ROOT` env var, set by the Rust sidecar when spawning Node (mirrors the existing `HEIMDALL_REPO_ROOT` pattern exactly — same bundled-resource-first, dev-checkout-fallback precedence, extracted into a shared `icon_sets_root_candidates()` helper in `sidecar.rs` rather than duplicated). Headless/dev usage (no Tauri wrapper) falls back to the real path in the git checkout.
3. `dashboard.ts`'s icon picker renders `<img class="icon-thumb" src="/desktop-icon/{name}/thumbnail.png">` per option instead of an emoji span. `ICON_GLYPHS` deleted entirely, not left as dead code.

No changes to any icon's own drawing source, `cargo tauri icon` invocation, or the Dock/tray icon resolution logic (`resolve_icon_path`, `apply_icon_preference`) — all confirmed correct and untouched; this was purely a missing preview surface in the Settings UI.

## 4. Verification

Live-verified, not just unit-tested: started a real dev server, curled the new route directly (confirmed real PNG bytes, correct `content-type`, valid PNG magic bytes), confirmed unrecognized/path-traversal names correctly 404, then loaded the actual dashboard in a real browser and confirmed all three `<img>` thumbnails load successfully with real, non-zero dimensions — not just that the server responds, but that the picker the operator actually looks at now shows the real artwork.

## 5. Scale assessment

**Small.** One new route, one new env var following an established pattern, one UI rendering change. No design/drawing-source work needed anywhere — confirmed unnecessary by the operator directly.
