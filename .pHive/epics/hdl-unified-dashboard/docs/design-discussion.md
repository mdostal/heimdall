# Design Discussion — hdl-unified-dashboard

## 0. This epic's spec is the operator's own message, verbatim

No design fork to resolve here — the operator's synthesis message, after
reviewing all 6 published mockups (3 UI directions, 3 icon concepts) side
by side, IS the spec:

> "the lane control is my favorite with the moving radar and the dots, i
> think that's solid. The model catalog with the tree underneath is
> clearer and cleaner... most of the rest of it actually is the same, so
> we should be able to just swap the theming and styles and offer that in
> a settings page and that'd be REALLY SLICK! Let's roll with a unified
> feature view like that and settings swaps."

Followed up with screenshots pinpointing exactly which mockup regions they
meant (the override toggle+reason column from both Mission Control and
Terminal, the Fleet Scope radar, the Model Catalog tree) — removing any
ambiguity about scope before implementation started.

One genuine open question remained: which theme is DEFAULT (the operator
named default ICON explicitly — Watchtower — but not default theme).
Asked via `AskUserQuestion` rather than guessed; operator picked Mission
Control.

## 1. What "unified" means precisely

Two specific widgets — Fleet Scope (radar+dots) and Model Catalog (tree) —
graduate from "one mockup's particular flourish" to "the permanent way
Heimdall shows this data, in every theme." Only the surrounding palette
and typography are theme-dependent; the widgets' structure is not.
Concretely: `renderFleetScope()`/`renderModelCatalog()` are unconditional,
always-rendered functions — there is no per-theme branch that swaps them
out for a different widget. Theming operates entirely through CSS custom
properties (`--hd-*` tokens), never through conditional markup.

## 2. Porting the radar honestly, not approximately

The Mission Control mockup's "Fleet Scope" is an SVG (not canvas), with 6
sample lane blips positioned by hand-authored coordinates. Before writing
any live-data version, those sample coordinates were back-computed to
recover the actual placement rule: angle = `(index / N) * 360°` (clockwise
from 12 o'clock, in lane-array order), radius by severity tier — `up` =
outer ring (90), `degraded` = mid ring (60), `{out_of_credit, down}` =
inner ring (30, both severe/blocking states sharing one tier — verified
against the mockup's own choice, not invented). A lane under manual
override renders as a hollow ring (no filled center) at its real sensed-
severity position, not a separate "overridden" ring — confirmed by
back-computing the mockup's own `kimi` sample (up + operator-disabled,
rendered hollow at the *outer*/up position, not some neutral middle
ground). This makes the live version a faithful continuation of the
verified design, not a re-interpretation drawn from vibes.

## 3. Token system shape

Three complete, independent, named palettes (`mission-control` default,
`harbor-watch`, `terminal`) — deliberately NOT a `prefers-color-scheme`
light/dark auto-detection system, since these are product identities an
operator explicitly picks, not accessibility-driven appearance. Each
theme's real hex/rgba values were extracted directly from its origin
mockup's own `:root` token block (Mission Control's single committed dark
world; Harbor Watch's light variant; Terminal's dark variant, chosen over
its light one for stronger visual differentiation from Harbor Watch, which
already covers the light end of the spectrum). One canonical token
vocabulary (`--hd-bg`, `--hd-surface`, `--hd-text`, `--hd-accent`,
`--hd-status-{up,degraded,credit,down,off}`, `--hd-font-{ui,mono,display}`,
etc.) — every mockup used different variable names internally; Heimdall's
own dashboard needed one consistent set all three themes fill in.

`GET /` sets `data-theme` server-side on the initial HTML response
(omitted entirely for the default, since the bare `:root` already IS
Mission Control) — the Settings panel's client-side theme switch is
instant and reload-free, but a fresh page load never flashes the wrong
theme while waiting for JS.

## 4. Icon settings split into two epics, deliberately

The Node-side preference persistence (`GET/POST /desktop-icon`) ships here
because it's the same small, well-understood pattern as `/theme` and
belongs in the same Settings panel UI. The Rust-side consumption (actually
making the running desktop app's tray icon change, and bundling all 3
icon sets for a rebuild to pick up a new Dock icon) is real, separate,
cross-language work with its own verification needs — split into
`hdl-desktop-icon-settings` rather than inflating this already-large epic
further. The Settings panel's copy is honest about the split today (shows
the real rebuild command) rather than silently implying more than the
Node side alone can deliver.

## 5. Real bug found during live verification

The lanes table (10 columns: lane, provider, model, status, token, reason,
reset at, last updated, signal source, override) could overflow the
1180px-max-width body at real, unremarkable browser widths — confirmed
live via Playwright (`scrollWidth` exceeded `clientWidth`), not assumed
from reading the CSS. This predates this epic (the column count didn't
change), but was only caught now because this epic's live-verification
pass was the first time this session checked page-level overflow rather
than individual widget rendering. Fixed with `overflow-x: auto` scoped to
`#root`, matching the artifact-design skill's own rule that wide content
scrolls in its own container — the page body itself must never scroll
sideways.
