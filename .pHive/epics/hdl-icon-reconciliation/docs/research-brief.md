# Research Brief — hdl-icon-reconciliation

> **Correction (post-hoc, see design-discussion.md §0-§1):** this research
> pass correctly refuted the cache-staleness hypothesis but then chased a
> real-looking icon-legibility "bug" that the operator directly confirmed
> is not a problem — the cone/beacon rendering IS the approved design at
> every size. The actual root cause was elsewhere entirely: the Settings
> picker UI never showed the real artwork at all, only placeholder emoji.
> Left below unmodified as an honest record of what was actually
> investigated (including the wrong turn), not rewritten to look clean in
> hindsight.

## Requirement

Operator, after `hdl-desktop-icon-settings` shipped: *"Use the actual icons we saw"* — the Watchtower icon currently installed does not match what was approved when reviewing the published Artifact mockup. Needs real root-cause diagnosis before any fix, not another guess layered on top of the prior session's assumptions.

## What was already established before this research pass

- Three icon concepts (Watchtower, Routing Mark, Signal Horn) were Canvas-drawn HTML mockups, published as Claude Artifacts, reviewed by the operator live in their own real browser. Operator picked Watchtower as default.
- Rasterized to 1024×1024 PNGs via Playwright's `canvas.toDataURL()` (Playwright's own screenshot tool doesn't work in this sandboxed environment), then run through `cargo tauri icon` to produce the full macOS icon set now embedded in `app/src-tauri/icons/` and `app/src-tauri/resources/icon-sets/watchtower/`.
- Re-fetched the actual published Artifact source (`https://claude.ai/code/artifact/953408ef-0864-419d-bfec-1ef5eaf54c44`, still live under the operator's own account) via WebFetch and confirmed its embedded `drawWatchtowerIcon()` JS is byte-identical to the local file used for rasterization.
- Re-rendered that exact source fresh via Playwright (real Chrome 151 engine — `ctx.roundRect` confirmed supported, ruling out a headless-canvas-API-gap theory) and reproduced the same visual result pixel-for-pixel as the original rasterization.
- The installed `/Applications/Heimdall.app`'s actual `icon.icns` file hash matched the freshly-built one exactly — the bundle is not stale relative to what was built from source.

## Research pass findings (this epic)

**Hypothesis A — macOS Dock/Finder icon-cache staleness: REFUTED.**
Queried macOS's actual icon-resolution system (`NSWorkspace.iconForFile`) for `/Applications/Heimdall.app` via a non-screen-capture ObjC-bridge method (avoids any risk of an accidental screen capture touching unrelated windows), force-cleared the relevant caches (`killall iconservicesagent`, `killall Dock`, `killall Finder`, `touch` on the bundle to bump mtime), and re-queried. Both system processes relaunched cleanly. Before/after pixel diff: max channel delta 5/255 across 0.2% of pixels — re-encoding noise, not a different asset. `icon.icns` hash already matched the repo build before any cache-busting. Dock's `persistent-apps` plist has no stale Heimdall entry. **There is no caching bug** — the system was already resolving the current Watchtower asset correctly, every time.

**Hypothesis B — real Dock/Finder/menu-bar-size legibility: CONFIRMED.**
Read `app/src-tauri/resources/icon-sets/watchtower/{32x32,128x128}.png` directly, and separately the representation macOS itself resolves from the `.icns`. At every size — including the full 1024px "hero" render — the icon reads as a smooth blue tapered cone/spotlight with a glowing orange orb on top and a single orange arc beneath it. No crenellations, brick texture, or tower silhouette are visible at ANY size, not just small ones. It reads as a lighthouse beam, traffic cone, or rocket nose cone — not a watchtower.

## Root cause

The icon's own source code comment describes the crenellations as rendered with `rimeMistDeep` — the SAME color used for the tower body's own shadow-side gradient stop. The merlon rectangles are real, present, and correctly positioned in the code (confirmed via source read), but they have **zero contrast** against the tower they sit on — they blend into the gradient shading at every resolution, including the crisp 1024px master the operator reviewed. This was never a downscaling/small-size problem specifically; the silhouette was never clearly "tower-shaped" to begin with, at any size. The operator's own recollection of "the icon we saw" (a distinct, recognizable watchtower) is closer to what the source code *intends* to draw than what it actually renders as — a genuine implementation gap between the design's description and its own visual output, not a build, bundling, or caching defect anywhere in the pipeline this session built.

## Scope implication for this epic

The fix is confined to the Watchtower icon's own drawing source (one HTML/Canvas file) plus regenerating its derived macOS icon set and re-bundling — no changes needed to `cargo tauri icon` invocation, `tauri.conf.json` resource mapping, `sidecar.rs`'s icon-path resolution, or any caching/build-pipeline code, all of which are already confirmed working correctly. Routing Mark and Signal Horn are unaffected (not implicated by either hypothesis test, and the operator's own prior sign-off called them "recognizable" specifically in contrast to any concern about Watchtower).
