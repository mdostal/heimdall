// Live lane-status dashboard — the standalone-mode UI requirement
// (has_ui: true, .pHive/project-profile.yaml). Self-contained HTML/CSS/JS:
// no build step, no framework, no new npm dependency, no external network
// calls — a consumer of Heimdall's own HTTP surface only.
//
// hdl-lane-status-ui: read-only live status (GET /lanes, polled every 5s).
// hdl-lane-override: per-lane enable/disable/auto controls, routed through
//   the same ControlAdapter.reconcile() decision automatic sensing uses
//   (POST /lanes/:laneId/override) — never a separate mechanism.
// hdl-lane-management: add a lane (POST /lanes, writes a local .env block,
//   restart required — see src/core/env-file.ts), a token-configured
//   indicator (credential_configured, never the secret itself), and manual
//   reset_at editing ("change the times" — POST /lanes/:laneId/reset-at,
//   feeds the already-shipped reset_at-aware scheduler from
//   hdl-reason-aware-recovery). See
//   docs/decisions/DEC-hdl-reason-aware-recovery.md item 3 and
//   .pHive/epics/hdl-lane-management/docs/design-discussion.md.

const KNOWN_THEMES = ["mission-control", "harbor-watch", "terminal"];

export function renderDashboardHtml(activeTheme: string = "mission-control"): string {
  // hdl-unified-dashboard: data-theme is set server-side on the initial
  // response (not left to client JS alone) so the correct theme paints on
  // first render -- no flash of the default theme before JS runs. Mission
  // Control needs no attribute at all (the CSS's bare :root already IS
  // Mission Control), matching how the CSS itself is structured. Defends
  // against an unrecognized value the same way this codebase's other
  // narrow validators do (isCostPreference, isErrorCode, ...) rather than
  // trusting the caller alone -- falls back to the default instead of
  // interpolating an arbitrary string into the HTML attribute.
  const safeTheme = KNOWN_THEMES.includes(activeTheme) ? activeTheme : "mission-control";
  const themeAttr = safeTheme !== "mission-control" ? ` data-theme="${safeTheme}"` : "";
  return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heimdall — Lane Status</title>
<style>
  /* ============================================================
     THEME TOKENS — hdl-desktop-app-theming. Three named, hand-picked
     product themes an operator explicitly chooses (via the Settings
     panel), NOT a light/dark auto-detection system — each theme is one
     deliberate, complete palette. Ported from the three independently
     designed dashboard mockups reviewed during the UI redesign pass;
     operator's synthesis (2026-08-18): Mission Control's radar+dots lane
     view and Terminal's tree-style model catalog become the permanent,
     universal widgets across every theme (not exclusive to their origin
     theme) — only the surrounding palette/typography swaps per theme.
     Mission Control is the default (bare :root, no [data-theme] needed).
  ============================================================ */
  :root {
    color-scheme: dark;
    --hd-bg: #0a0d13;
    --hd-surface: #111826;
    --hd-surface-2: #161f30;
    --hd-border: #212c40;
    --hd-border-strong: #2e3c56;
    --hd-text: #e8edf5;
    --hd-text-muted: #93a1b8;
    --hd-text-faint: #57647c;
    --hd-accent: #6f7bf7;
    --hd-accent-strong: #8891fa;
    --hd-accent-soft: rgba(111, 123, 247, 0.14);
    --hd-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    --hd-font-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --hd-font-display: var(--hd-font-mono);
    --hd-status-up: #34d399;
    --hd-status-up-bg: rgba(52, 211, 153, 0.14);
    --hd-status-degraded: #f0b13e;
    --hd-status-degraded-bg: rgba(240, 177, 62, 0.14);
    --hd-status-credit: #ec5fa8;
    --hd-status-credit-bg: rgba(236, 95, 168, 0.14);
    --hd-status-down: #ff5c5c;
    --hd-status-down-bg: rgba(255, 92, 92, 0.14);
    --hd-status-off: #8b98ad;
    --hd-status-off-bg: rgba(139, 152, 173, 0.14);
    --hd-radius: 4px;
    --hd-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  }
  :root[data-theme="harbor-watch"] {
    color-scheme: light;
    --hd-bg: #F5F7F6;
    --hd-surface: #FFFFFF;
    --hd-surface-2: #EEF2F1;
    --hd-border: #DCE4E2;
    --hd-border-strong: #C3CFCC;
    --hd-text: #101E22;
    --hd-text-muted: #56676A;
    --hd-text-faint: #90A0A1;
    --hd-accent: #146B67;
    --hd-accent-strong: #0E4F4C;
    --hd-accent-soft: #E4F1EE;
    --hd-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --hd-font-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
    --hd-font-display: Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    --hd-status-up: #2E7D4F;
    --hd-status-up-bg: #E4F3E9;
    --hd-status-degraded: #A5710E;
    --hd-status-degraded-bg: #FBF1DE;
    --hd-status-credit: #8A2E3E;
    --hd-status-credit-bg: #F8E8EA;
    --hd-status-down: #56676A;
    --hd-status-down-bg: #E9EDEC;
    --hd-status-off: #56676A;
    --hd-status-off-bg: #E9EDEC;
    --hd-radius: 6px;
    --hd-shadow: 0 1px 2px rgba(16, 30, 34, 0.04), 0 6px 20px -12px rgba(16, 30, 34, 0.10);
  }
  :root[data-theme="terminal"] {
    color-scheme: dark;
    --hd-bg: #12151A;
    --hd-surface: #181C22;
    --hd-surface-2: #1F242B;
    --hd-border: #2B313A;
    --hd-border-strong: #262C34;
    --hd-text: #E7E4DC;
    --hd-text-muted: #9198A3;
    --hd-text-faint: #656C78;
    --hd-accent: #6FBDB5;
    --hd-accent-strong: #8FD4CC;
    --hd-accent-soft: rgba(111, 189, 181, 0.12);
    --hd-font-ui: ui-monospace, "JetBrains Mono", "Berkeley Mono", "Cascadia Code", "SF Mono", "IBM Plex Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --hd-font-mono: var(--hd-font-ui);
    --hd-font-display: var(--hd-font-ui);
    --hd-status-up: #5FB88B;
    --hd-status-up-bg: rgba(95, 184, 139, 0.14);
    --hd-status-degraded: #E0A63D;
    --hd-status-degraded-bg: rgba(224, 166, 61, 0.14);
    --hd-status-credit: #D9678C;
    --hd-status-credit-bg: rgba(217, 103, 140, 0.14);
    --hd-status-down: #D65F5F;
    --hd-status-down-bg: rgba(214, 95, 95, 0.14);
    --hd-status-off: #8D93A0;
    --hd-status-off-bg: rgba(141, 147, 160, 0.14);
    --hd-radius: 2px;
    --hd-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  }
  body {
    font-family: var(--hd-font-ui);
    background: var(--hd-bg);
    color: var(--hd-text);
    margin: 2rem;
    max-width: 1180px;
  }
  /* hdl-unified-dashboard: found via live verification, not assumed --
     the lanes table (10 columns) can exceed the viewport at real browser
     widths. Scrolls within its own box, matching the artifact-design
     skill's own "wide content gets overflow-x:auto on its own container"
     rule -- the page body itself must never scroll sideways. */
  #root { overflow-x: auto; }
  h1 { font-family: var(--hd-font-display); font-size: 1.25rem; margin-bottom: 0.25rem; }
  h2 { font-family: var(--hd-font-display); font-size: 1rem; margin: 0 0 0.75rem; }
  a { color: var(--hd-accent); }
  .subtitle { color: var(--hd-text-muted); font-size: 0.85rem; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--hd-border);
    font-size: 0.9rem;
    vertical-align: middle;
  }
  th { font-weight: 600; color: var(--hd-text-muted); }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--hd-bg);
  }
  .badge-up { background: var(--hd-status-up); }
  .badge-degraded { background: var(--hd-status-degraded); }
  .badge-down { background: var(--hd-status-down); }
  .badge-out_of_credit { background: var(--hd-status-credit); }
  .override-badge {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--hd-bg);
    background: var(--hd-status-off);
  }
  .chip {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid var(--hd-border-strong);
  }
  .chip-missing { color: var(--hd-status-down); border-color: var(--hd-status-down); }
  .error-code-chip {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    border-radius: var(--hd-radius);
    font-size: 0.7rem;
    font-family: var(--hd-font-mono);
    background: var(--hd-surface-2);
    color: var(--hd-text-muted);
  }
  .empty-state { color: var(--hd-text-muted); padding: 2rem 0; }
  .reason { color: var(--hd-text-muted); font-size: 0.85rem; }
  .gateway-header td {
    background: var(--hd-surface-2);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--hd-text-muted);
    padding-top: 0.75rem;
  }
  .override-controls button, .reset-at-controls button {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    margin-right: 0.25rem;
    border: 1px solid var(--hd-border-strong);
    border-radius: var(--hd-radius);
    background: transparent;
    color: var(--hd-text);
    cursor: pointer;
    font-family: inherit;
  }
  .override-controls button.active {
    border-color: var(--hd-accent);
    color: var(--hd-accent-strong);
    font-weight: 600;
  }
  .override-reason-input {
    display: block;
    font-size: 0.75rem;
    padding: 0.15rem 0.35rem;
    margin-top: 0.3rem;
    width: 12rem;
    max-width: 100%;
    border: 1px solid var(--hd-border-strong);
    border-radius: var(--hd-radius);
    background: var(--hd-surface);
    color: inherit;
    font-family: inherit;
  }
  .reset-at-controls {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.35rem;
  }
  .reset-at-controls input[type="datetime-local"] {
    font-size: 0.78rem;
    padding: 0.1rem 0.3rem;
    background: var(--hd-surface);
    color: var(--hd-text);
    border: 1px solid var(--hd-border-strong);
    border-radius: var(--hd-radius);
  }
  .panel {
    background: var(--hd-surface);
    border: 1px solid var(--hd-border);
    border-radius: calc(var(--hd-radius) * 2);
    box-shadow: var(--hd-shadow);
    padding: 1rem 1.25rem;
    margin-bottom: 1.75rem;
    max-width: 640px;
  }
  .panel .row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .panel input, .panel select {
    flex: 1 1 140px;
    padding: 0.4rem 0.5rem;
    font-size: 0.85rem;
    font-family: inherit;
    border: 1px solid var(--hd-border-strong);
    border-radius: var(--hd-radius);
    background: var(--hd-bg);
    color: var(--hd-text);
  }
  .panel select {
    flex: 0 1 220px;
  }
  .panel button[type="submit"], .panel button[type="button"] {
    padding: 0.4rem 1rem;
    font-size: 0.85rem;
    font-family: inherit;
    border: 1px solid var(--hd-accent);
    border-radius: var(--hd-radius);
    background: transparent;
    color: var(--hd-accent-strong);
    cursor: pointer;
    flex: 0 0 auto;
  }
  .strategy-status { font-size: 0.85rem; color: var(--hd-text-muted); margin-bottom: 0.6rem; }
  .model-created-at { color: var(--hd-text-muted); font-size: 0.78rem; margin-left: 0.4rem; }
  .banner {
    margin-top: 0.75rem;
    padding: 0.6rem 0.8rem;
    border-radius: var(--hd-radius);
    font-size: 0.85rem;
  }
  .banner-ok { background: var(--hd-status-up-bg); border: 1px solid var(--hd-status-up); }
  .banner-error { background: var(--hd-status-down-bg); border: 1px solid var(--hd-status-down); }
  .banner code {
    font-family: var(--hd-font-mono);
    background: var(--hd-surface-2);
    padding: 0.05em 0.4em;
    border-radius: 3px;
  }

  /* ---------- Fleet Scope: radar + status dots (Mission Control-origin, now universal) ---------- */
  .scope-wrap { display: flex; justify-content: center; margin: 0.5rem 0; }
  .scope-svg .ring, .scope-svg .axis { stroke: var(--hd-border); }
  .scope-svg .center-dot { fill: var(--hd-text-faint); }
  .scope-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.9rem;
    font-size: 0.78rem;
    color: var(--hd-text-muted);
    justify-content: center;
  }
  .scope-legend .legend-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 0.3rem;
    vertical-align: middle;
  }

  /* ---------- Model catalog tree (Terminal-origin, now universal) ---------- */
  .catalog-tree { display: flex; flex-direction: column; gap: 1rem; }
  .catalog-tree .provider-name {
    font-family: var(--hd-font-mono);
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--hd-text);
    margin-bottom: 0.3rem;
  }
  .catalog-tree ul { list-style: none; padding: 0; margin: 0; }
  .catalog-tree li {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.8125rem;
    padding: 0.2rem 0;
  }
  .catalog-tree .tree-glyph { font-family: var(--hd-font-mono); color: var(--hd-text-faint); flex: none; }
  .catalog-tree .model-name { color: var(--hd-text); cursor: pointer; }
  .catalog-tree .model-name.disabled { color: var(--hd-text-faint); text-decoration: line-through; text-decoration-color: var(--hd-border-strong); }
  .catalog-tree .model-flag { font-size: 0.6875rem; margin-left: 0.35rem; }
  .catalog-tree .model-flag.on { color: var(--hd-status-up); }
  .catalog-tree .model-flag.off { color: var(--hd-text-faint); }
  .catalog-tree input[type="checkbox"] { margin: 0; }

  /* ---------- Settings ---------- */
  .theme-picker { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .theme-option {
    border: 1px solid var(--hd-border-strong);
    border-radius: var(--hd-radius);
    padding: 0.5rem 0.9rem;
    font-size: 0.85rem;
    cursor: pointer;
    background: transparent;
    color: var(--hd-text);
    font-family: inherit;
  }
  .theme-option.active { border-color: var(--hd-accent); color: var(--hd-accent-strong); font-weight: 600; }
  .icon-picker { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.5rem; }
  .icon-option {
    border: 1px solid var(--hd-border-strong);
    border-radius: var(--hd-radius);
    padding: 0.5rem 0.7rem;
    font-size: 0.8rem;
    cursor: pointer;
    background: transparent;
    color: var(--hd-text);
    font-family: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    width: 5.5rem;
  }
  .icon-option.active { border-color: var(--hd-accent); color: var(--hd-accent-strong); font-weight: 600; }
  .icon-option .icon-glyph { font-size: 1.4rem; }
  .settings-note { font-size: 0.78rem; color: var(--hd-text-faint); margin-top: 0.5rem; }
</style>
</head>
<body>
  <h1>Heimdall — Lane Status <a href="/docs" style="font-size:0.6em;font-weight:400;">Docs &rarr;</a></h1>
  <div class="subtitle">Polls <code>GET /lanes</code> every 5s · manual overrides route through the same ControlAdapter Heimdall already uses for automatic sensing</div>

  <div class="panel">
    <h2>Fleet Scope</h2>
    <div class="strategy-status">Every lane plotted by severity — distance from center: outer ring = up, mid ring = degraded, inner ring = out of credit or down. A hollow ring means the lane is manually overridden.</div>
    <div class="scope-wrap" id="fleet-scope-root"></div>
    <div class="scope-legend">
      <span><i class="legend-dot" style="background:var(--hd-status-up)"></i>up</span>
      <span><i class="legend-dot" style="background:var(--hd-status-degraded)"></i>degraded</span>
      <span><i class="legend-dot" style="background:var(--hd-status-credit)"></i>out of credit</span>
      <span><i class="legend-dot" style="background:var(--hd-status-down)"></i>down</span>
      <span><i class="legend-dot" style="border:1.3px solid var(--hd-status-off);background:transparent"></i>overridden</span>
    </div>
  </div>

  <div class="panel">
    <h2>Routing strategy</h2>
    <div id="routing-strategy-status">Loading…</div>
    <div class="row">
      <select id="routing-strategy-select"></select>
      <button type="button" id="routing-strategy-save">Save</button>
    </div>
    <div id="routing-strategy-banner"></div>
  </div>

  <div class="panel">
    <h2>Model catalog</h2>
    <div class="strategy-status">What's actually callable right now, per provider — <code>GET /available-route</code> substitutes the newest enabled model when a lane's declared one is disabled or gone.</div>
    <div class="row">
      <button type="button" id="model-catalog-refresh">Refresh from providers</button>
    </div>
    <div id="model-catalog-banner"></div>
    <div id="model-catalog-root">Loading…</div>
  </div>

  <div class="panel">
    <h2>Telemetry</h2>
    <div class="strategy-status">Heimdall's own local metrics — <code>GET /metrics</code> (Prometheus text format), never dependent on Argus or any other external collector.</div>
    <div id="telemetry-root">Loading…</div>
  </div>

  <div class="panel">
    <h2>Routing policy</h2>
    <div class="strategy-status">Read-only view of <code>config/routing-policy.yaml</code> — hand-edit the file to change it, this just makes the active weights/experiments visible without reading YAML.</div>
    <div id="routing-policy-root">Loading…</div>
  </div>

  <div class="panel">
    <h2>Add lane</h2>
    <form id="add-lane-form">
      <div class="row">
        <input type="text" name="lane_id" placeholder="lane id (e.g. gemini@ops)" required>
        <input type="text" name="provider" placeholder="provider (e.g. gemini)" required>
      </div>
      <div class="row">
        <input type="text" name="model" placeholder="model (e.g. gemini-3-pro)" required>
        <input type="password" name="token" placeholder="token" required>
        <button type="submit">Add lane</button>
      </div>
    </form>
    <div id="add-lane-banner"></div>
  </div>

  <div class="panel">
    <h2>Settings</h2>
    <div class="strategy-status">Theme</div>
    <div class="theme-picker" id="theme-picker"></div>
    <div class="strategy-status" style="margin-top:1rem;">Desktop app icon</div>
    <div class="icon-picker" id="icon-picker"></div>
    <div class="settings-note" id="icon-settings-note"></div>
  </div>

  <div id="root">Loading…</div>

<script>
(function () {
  var BADGE_LABEL = {
    up: "up",
    degraded: "degraded",
    down: "down",
    out_of_credit: "out of credit"
  };

  function formatResetAt(resetAt) {
    if (!resetAt) return "";
    var d = new Date(resetAt);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  // datetime-local inputs use LOCAL time with no offset (YYYY-MM-DDTHH:mm) —
  // converts an ISO/UTC timestamp into that shape using local getters.
  function toDatetimeLocalValue(isoString) {
    if (!isoString) return "";
    var d = new Date(isoString);
    if (isNaN(d.getTime())) return "";
    function pad(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function overrideBadge(manualOverride) {
    if (!manualOverride) return "";
    return "<span class=\\"override-badge\\">manual: " + escapeHtml(manualOverride) + "</span>";
  }

  function priorityBadge(priority) {
    if (priority === null || priority === undefined) return "";
    return "<span class=\\"override-badge\\">priority: " + escapeHtml(String(priority)) + "</span>";
  }

  function overrideControls(lane) {
    var current = lane.manual_override || "auto";
    var laneAttr = escapeHtml(lane.lane_id);
    function btn(state, label) {
      var activeClass = current === state ? " active" : "";
      return (
        "<button type=\\"button\\" class=\\"" + activeClass.trim() + "\\" data-lane=\\"" + laneAttr +
        "\\" data-state=\\"" + state + "\\">" + label + "</button>"
      );
    }
    // hdl-override-reason: the reason input always renders (not just while
    // overridden) so a reason can be typed BEFORE clicking Enable/Disable —
    // the click handler reads this input's live value at click time.
    // Backend already discards any reason when the resulting state is
    // "auto", so no client-side gating is needed here either.
    var reasonInput =
      "<input type=\\"text\\" class=\\"override-reason-input\\" placeholder=\\"reason (optional)\\" " +
      "data-lane=\\"" + laneAttr + "\\" value=\\"" + escapeHtml(lane.override_reason || "") + "\\">";
    var reasonDisplay = lane.override_reason
      ? "<div class=\\"reason override-reason-note\\">\\u201c" + escapeHtml(lane.override_reason) + "\\u201d</div>"
      : "";
    return (
      "<span class=\\"override-controls\\">" +
      btn("enabled", "Enable") + btn("disabled", "Disable") + btn("auto", "Auto") +
      "</span>" + reasonInput + reasonDisplay
    );
  }

  function tokenChip(lane) {
    if (lane.credential_configured) return "<span class=\\"chip\\">configured</span>";
    return "<span class=\\"chip chip-missing\\">token missing</span>";
  }

  function resetAtCell(lane) {
    var effective = lane.manual_reset_at || lane.reset_at;
    var display = formatResetAt(effective);
    var manualBadge = lane.manual_reset_at
      ? "<span class=\\"override-badge\\">manual</span>"
      : "";
    var laneAttr = escapeHtml(lane.lane_id);
    var inputValue = toDatetimeLocalValue(effective);
    var clearBtn = lane.manual_reset_at
      ? "<button type=\\"button\\" data-lane=\\"" + laneAttr + "\\" data-reset-clear=\\"1\\">Clear</button>"
      : "";
    return (
      "<div>" + escapeHtml(display) + manualBadge + "</div>" +
      "<div class=\\"reset-at-controls\\">" +
      "<input type=\\"datetime-local\\" data-lane=\\"" + laneAttr + "\\" value=\\"" + inputValue + "\\">" +
      "<button type=\\"button\\" data-lane=\\"" + laneAttr + "\\" data-reset-save=\\"1\\">Save</button>" +
      clearBtn +
      "</div>"
    );
  }

  function errorCodeChip(lane) {
    // hdl-error-taxonomy: the normalized code, distinct from the native
    // reason text — "degraded from X" at a glance, full detail still in the
    // reason cell right next to it.
    if (!lane.error_code) return "";
    return "<span class=\\"error-code-chip\\">" + escapeHtml(lane.error_code) + "</span> ";
  }

  function renderRow(lane) {
    var badgeClass = "badge badge-" + escapeHtml(lane.status);
    var label = BADGE_LABEL[lane.status] || lane.status;
    return (
      "<tr>" +
      "<td>" + escapeHtml(lane.lane_id) + "</td>" +
      "<td>" + escapeHtml(lane.provider) + "</td>" +
      "<td>" + escapeHtml(lane.model || "") + priorityBadge(lane.priority) + "</td>" +
      "<td><span class=\\"" + badgeClass + "\\">" + escapeHtml(label) + "</span>" + overrideBadge(lane.manual_override) + "</td>" +
      "<td>" + tokenChip(lane) + "</td>" +
      "<td class=\\"reason\\">" + errorCodeChip(lane) + escapeHtml(lane.reason) + "</td>" +
      "<td>" + resetAtCell(lane) + "</td>" +
      "<td>" + escapeHtml(lane.last_updated) + "</td>" +
      "<td>" + escapeHtml(lane.signal_source) + "</td>" +
      "<td>" + overrideControls(lane) + "</td>" +
      "</tr>"
    );
  }

  // hdl-or-03: group lanes sharing a gateway credential_ref (e.g. multiple
  // OpenRouter routes) under one header row. A credential_ref used by
  // exactly one lane is NOT a gateway — that lane renders in its natural
  // position with no header inserted, same flat list as every other
  // single-credential provider.
  function groupLanesByCredential(lanes) {
    var countByCredential = {};
    lanes.forEach(function (lane) {
      var key = lane.credential_ref || "";
      if (!key) return;
      countByCredential[key] = (countByCredential[key] || 0) + 1;
    });

    var seenGroupHeader = {};
    var htmlParts = [];
    lanes.forEach(function (lane) {
      var key = lane.credential_ref || "";
      var isGrouped = key && countByCredential[key] > 1;
      if (isGrouped && !seenGroupHeader[key]) {
        seenGroupHeader[key] = true;
        htmlParts.push(
          "<tr class=\\"gateway-header\\">" +
          "<td colspan=\\"10\\">" + escapeHtml(lane.provider) + " gateway — credential: " + escapeHtml(key) + "</td>" +
          "</tr>",
        );
      }
      htmlParts.push(renderRow(lane));
    });
    return htmlParts.join("");
  }

  // Fleet Scope radar (hdl-unified-dashboard) — ported from the Mission
  // Control mockup's SVG (not canvas): 3 concentric severity rings, each
  // lane plotted at angle (index/N * 360°, clockwise from top) and radius
  // by severity tier — up=outer(90), degraded=mid(60), {out_of_credit,
  // down}=inner(30), matching the mockup's own real geometry (verified by
  // back-computing its sample blip coordinates, not guessed). A manual
  // override renders as a hollow ring at the lane's real sensed-severity
  // position — the position always reflects what's actually happening;
  // hollow vs. filled reflects only whether an operator is overriding it.
  var SCOPE_RING = { up: 90, degraded: 60, out_of_credit: 30, down: 30 };
  var SCOPE_COLOR_VAR = {
    up: "--hd-status-up",
    degraded: "--hd-status-degraded",
    out_of_credit: "--hd-status-credit",
    down: "--hd-status-down",
  };

  function renderFleetScope(lanes) {
    var root = document.getElementById("fleet-scope-root");
    if (!lanes || lanes.length === 0) {
      root.innerHTML = "";
      return;
    }
    var n = lanes.length;
    var blips = "";
    lanes.forEach(function (lane, i) {
      var ring = SCOPE_RING[lane.status] || SCOPE_RING.down;
      var angle = (i / n) * 2 * Math.PI;
      var cx = (100 + ring * Math.sin(angle)).toFixed(2);
      var cy = (100 - ring * Math.cos(angle)).toFixed(2);
      var colorVar = "var(" + (SCOPE_COLOR_VAR[lane.status] || SCOPE_COLOR_VAR.down) + ")";
      var title = escapeHtml(lane.lane_id) + " — " + escapeHtml(lane.status) + (lane.manual_override ? " (overridden)" : "");
      if (lane.manual_override) {
        blips +=
          "<g class=\\"blip\\"><title>" + title + "</title>" +
          "<circle cx=\\"" + cx + "\\" cy=\\"" + cy + "\\" r=\\"3.6\\" fill=\\"none\\" stroke=\\"var(--hd-status-off)\\" stroke-width=\\"1.3\\"/>" +
          "</g>";
      } else {
        blips +=
          "<g class=\\"blip\\"><title>" + title + "</title>" +
          "<circle cx=\\"" + cx + "\\" cy=\\"" + cy + "\\" r=\\"7\\" fill=\\"none\\" stroke=\\"" + colorVar + "\\" stroke-width=\\"1\\"/>" +
          "<circle cx=\\"" + cx + "\\" cy=\\"" + cy + "\\" r=\\"3\\" fill=\\"" + colorVar + "\\"/>" +
          "</g>";
      }
    });
    root.innerHTML =
      "<svg class=\\"scope-svg\\" width=\\"200\\" height=\\"200\\" viewBox=\\"0 0 200 200\\" role=\\"img\\" " +
      "aria-label=\\"Radar plot of " + n + " lane(s); distance from center indicates severity of the lane's current status.\\">" +
      "<circle class=\\"ring\\" cx=\\"100\\" cy=\\"100\\" r=\\"90\\" fill=\\"none\\" stroke-width=\\"1\\"/>" +
      "<circle class=\\"ring\\" cx=\\"100\\" cy=\\"100\\" r=\\"60\\" fill=\\"none\\" stroke-width=\\"1\\"/>" +
      "<circle class=\\"ring\\" cx=\\"100\\" cy=\\"100\\" r=\\"30\\" fill=\\"none\\" stroke-width=\\"1\\"/>" +
      "<line class=\\"axis\\" x1=\\"100\\" y1=\\"10\\" x2=\\"100\\" y2=\\"190\\" stroke-width=\\"1\\"/>" +
      "<line class=\\"axis\\" x1=\\"10\\" y1=\\"100\\" x2=\\"190\\" y2=\\"100\\" stroke-width=\\"1\\"/>" +
      blips +
      "<circle class=\\"center-dot\\" cx=\\"100\\" cy=\\"100\\" r=\\"1.6\\"/>" +
      "</svg>";
  }

  function render(lanes) {
    var root = document.getElementById("root");
    renderFleetScope(lanes);
    if (!lanes || lanes.length === 0) {
      root.innerHTML = "<div class=\\"empty-state\\">No lanes declared.</div>";
      return;
    }
    var rows = groupLanesByCredential(lanes);
    root.innerHTML =
      "<table>" +
      "<thead><tr>" +
      "<th>Lane</th><th>Provider</th><th>Model</th><th>Status</th><th>Token</th><th>Reason</th>" +
      "<th>Reset at</th><th>Last updated</th><th>Signal source</th><th>Override</th>" +
      "</tr></thead>" +
      "<tbody>" + rows + "</tbody>" +
      "</table>";
  }

  function poll() {
    fetch("/lanes")
      .then(function (res) { return res.json(); })
      .then(render)
      .catch(function (err) {
        var root = document.getElementById("root");
        root.innerHTML = "<div class=\\"empty-state\\">Failed to load lane status: " + escapeHtml(err) + "</div>";
      });
  }

  // Event delegation on #root — a single listener survives every re-render
  // (innerHTML replacement destroys any listeners attached directly to the
  // buttons/inputs themselves), matching this file's no-framework constraint.
  document.getElementById("root").addEventListener("click", function (event) {
    var overrideBtn = event.target.closest("button[data-state]");
    if (overrideBtn) {
      var laneId = overrideBtn.getAttribute("data-lane");
      var state = overrideBtn.getAttribute("data-state");
      var reasonInputEl = document.querySelector('.override-reason-input[data-lane="' + CSS.escape(laneId) + '"]');
      var reason = reasonInputEl ? reasonInputEl.value : "";
      overrideBtn.disabled = true;
      fetch("/lanes/" + encodeURIComponent(laneId) + "/override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: state, reason: reason })
      })
        .then(poll)
        .catch(function () { overrideBtn.disabled = false; });
      return;
    }

    var saveBtn = event.target.closest("button[data-reset-save]");
    if (saveBtn) {
      var saveLaneId = saveBtn.getAttribute("data-lane");
      var input = document.querySelector('input[type="datetime-local"][data-lane="' + CSS.escape(saveLaneId) + '"]');
      if (!input || !input.value) return;
      var isoValue = new Date(input.value).toISOString();
      saveBtn.disabled = true;
      fetch("/lanes/" + encodeURIComponent(saveLaneId) + "/reset-at", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset_at: isoValue })
      })
        .then(poll)
        .catch(function () { saveBtn.disabled = false; });
      return;
    }

    var clearBtn = event.target.closest("button[data-reset-clear]");
    if (clearBtn) {
      var clearLaneId = clearBtn.getAttribute("data-lane");
      clearBtn.disabled = true;
      fetch("/lanes/" + encodeURIComponent(clearLaneId) + "/reset-at", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset_at: null })
      })
        .then(poll)
        .catch(function () { clearBtn.disabled = false; });
    }
  });

  // Add-lane form — static, never re-rendered, so a direct listener (not
  // delegation) is fine here.
  document.getElementById("add-lane-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.target;
    var banner = document.getElementById("add-lane-banner");
    banner.innerHTML = "";
    var data = {
      lane_id: form.lane_id.value,
      provider: form.provider.value,
      model: form.model.value,
      token: form.token.value
    };
    fetch("/lanes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 201) {
          banner.innerHTML =
            "<div class=\\"banner banner-ok\\">Lane <code>" + escapeHtml(result.body.lane_id) +
            "</code> saved (credential_ref <code>" + escapeHtml(result.body.credential_ref) +
            "</code>). Restart Heimdall to activate it: <code>" + escapeHtml(result.body.restart_command) + "</code></div>";
          form.reset();
          poll();
        } else {
          banner.innerHTML = "<div class=\\"banner banner-error\\">" + escapeHtml(result.body.error || "add_lane_failed") + "</div>";
        }
      })
      .catch(function (err) {
        banner.innerHTML = "<div class=\\"banner banner-error\\">" + escapeHtml(err) + "</div>";
      });
  });

  // Routing strategy settings panel — loaded once on page load and again
  // after a save, not on the 5s lane-status poll: this is a config control,
  // not a live status row, and re-rendering the <select> under an
  // operator's cursor every 5s would be actively annoying.
  function renderRoutingStrategyStatus(active) {
    var status = document.getElementById("routing-strategy-status");
    if (active === "off") {
      status.innerHTML =
        "<div class=\\"strategy-status\\">Active: <strong>off</strong> — GET /available-route will return no_available_route for every request. Heimdall reports lane status; the caller decides.</div>";
    } else {
      status.innerHTML = "<div class=\\"strategy-status\\">Active: <strong>" + escapeHtml(active) + "</strong></div>";
    }
  }

  function loadRoutingStrategy() {
    fetch("/routing-strategy")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        renderRoutingStrategyStatus(data.active);
        var select = document.getElementById("routing-strategy-select");
        select.innerHTML = data.available
          .map(function (name) {
            var selected = name === data.active ? " selected" : "";
            return "<option value=\\"" + escapeHtml(name) + "\\"" + selected + ">" + escapeHtml(name) + "</option>";
          })
          .join("");
      });
  }

  document.getElementById("routing-strategy-save").addEventListener("click", function () {
    var select = document.getElementById("routing-strategy-select");
    var banner = document.getElementById("routing-strategy-banner");
    banner.innerHTML = "";
    fetch("/routing-strategy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: select.value })
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 200) {
          renderRoutingStrategyStatus(result.body.active);
        } else {
          banner.innerHTML = "<div class=\\"banner banner-error\\">" + escapeHtml(result.body.error || "set_routing_strategy_failed") + "</div>";
        }
      })
      .catch(function (err) {
        banner.innerHTML = "<div class=\\"banner banner-error\\">" + escapeHtml(err) + "</div>";
      });
  });

  // Model catalog panel (hdl-mcd-01) — loaded once on page load, same
  // reasoning as the routing-strategy panel just above: a config-browsing/
  // editing surface, not a live status row, so it's not on the 5s poll.
  // Tree-connector layout (hdl-unified-dashboard) — ported from the
  // Terminal mockup's model catalog. Checkbox interactivity (and its
  // data-provider/data-model attributes the change-event listener below
  // reads) is unchanged from the original table layout; only the visual
  // structure changed.
  function renderModelCatalog(entries) {
    var root = document.getElementById("model-catalog-root");
    if (!entries || entries.length === 0) {
      root.innerHTML = "<div class=\\"empty-state\\">No models seen yet — click Refresh to fetch from your configured providers.</div>";
      return;
    }
    var byProvider = {};
    entries.forEach(function (entry) {
      var list = byProvider[entry.provider] || (byProvider[entry.provider] = []);
      list.push(entry);
    });
    var html = "<div class=\\"catalog-tree\\">";
    Object.keys(byProvider).sort().forEach(function (provider) {
      var models = byProvider[provider];
      html += "<div class=\\"catalog-group\\"><div class=\\"provider-name\\">" + escapeHtml(provider) + "</div><ul>";
      models.forEach(function (entry, i) {
        var glyph = i === models.length - 1 ? "\\u2514\\u2500" : "\\u251C\\u2500";
        var checked = entry.enabled ? " checked" : "";
        var nameClass = entry.enabled ? "model-name" : "model-name disabled";
        var flagClass = entry.enabled ? "model-flag on" : "model-flag off";
        var flagText = entry.enabled ? "enabled" : "disabled";
        var createdAt = entry.provider_created_at
          ? "<span class=\\"model-created-at\\">" + escapeHtml(entry.provider_created_at) + "</span>"
          : "";
        html +=
          "<li><span class=\\"tree-glyph\\">" + glyph + "</span>" +
          "<label class=\\"" + nameClass + "\\">" +
          "<input type=\\"checkbox\\" data-provider=\\"" + escapeHtml(entry.provider) + "\\" data-model=\\"" + escapeHtml(entry.model_id) + "\\"" + checked + ">" +
          " " + escapeHtml(entry.model_id) +
          "</label>" +
          "<span class=\\"" + flagClass + "\\">" + flagText + "</span>" + createdAt +
          "</li>";
      });
      html += "</ul></div>";
    });
    html += "</div>";
    root.innerHTML = html;
  }

  function loadModelCatalog() {
    fetch("/models")
      .then(function (res) { return res.json(); })
      .then(renderModelCatalog)
      .catch(function (err) {
        document.getElementById("model-catalog-root").innerHTML =
          "<div class=\\"empty-state\\">Failed to load model catalog: " + escapeHtml(err) + "</div>";
      });
  }

  document.getElementById("model-catalog-refresh").addEventListener("click", function () {
    var btn = document.getElementById("model-catalog-refresh");
    var banner = document.getElementById("model-catalog-banner");
    banner.innerHTML = "";
    btn.disabled = true;
    fetch("/models/refresh", { method: "POST" })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        var providerCount = (result.providersRefreshed || []).length;
        banner.innerHTML =
          "<div class=\\"banner banner-ok\\">Refreshed " + escapeHtml(String(result.modelsSeen)) +
          " model(s) across " + escapeHtml(String(providerCount)) + " provider(s).</div>";
        loadModelCatalog();
      })
      .catch(function (err) {
        banner.innerHTML = "<div class=\\"banner banner-error\\">" + escapeHtml(err) + "</div>";
      })
      .then(function () { btn.disabled = false; });
  });

  // Dedicated listener — this panel's own root, not the page-wide #root
  // delegation used for lane rows.
  document.getElementById("model-catalog-root").addEventListener("change", function (event) {
    var checkbox = event.target.closest("input[type=\\"checkbox\\"][data-provider]");
    if (!checkbox) return;
    var provider = checkbox.getAttribute("data-provider");
    var modelId = checkbox.getAttribute("data-model");
    var enabled = checkbox.checked;
    checkbox.disabled = true;
    fetch("/models/" + encodeURIComponent(provider) + "/" + encodeURIComponent(modelId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: enabled })
    })
      .then(function () { checkbox.disabled = false; })
      .catch(function () {
        checkbox.checked = !enabled;
        checkbox.disabled = false;
      });
  });

  // Telemetry panel (hdl-ot-04) — loaded once on page load, same reasoning
  // as routing-strategy/model-catalog above: a summary surface, not a live
  // status row. Parses GET /metrics' Prometheus text format client-side —
  // a simple line regex, no new dependency, matching this file's own
  // "no framework, no build step" bar.
  function parsePrometheusText(text) {
    var families = {};
    var order = [];
    text.split("\\n").forEach(function (line) {
      if (line.indexOf("# HELP ") === 0) {
        var name = line.split(" ")[2];
        if (!families[name]) { families[name] = []; order.push(name); }
        return;
      }
      if (line.indexOf("#") === 0 || line.trim() === "") return;
      var match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\\{[^}]*\\})? (-?[0-9.]+)$/);
      if (!match) return;
      var name = match[1];
      if (!families[name]) { families[name] = []; order.push(name); }
      families[name].push({ labels: match[2] || "", value: match[3] });
    });
    return { families: families, order: order };
  }

  function renderTelemetry(text) {
    var root = document.getElementById("telemetry-root");
    var parsed = parsePrometheusText(text);
    var rows = [];
    parsed.order.forEach(function (name) {
      parsed.families[name].forEach(function (sample) {
        rows.push({ name: name, labels: sample.labels, value: sample.value });
      });
    });
    if (rows.length === 0) {
      root.innerHTML = "<div class=\\"empty-state\\">No telemetry recorded yet.</div>";
      return;
    }
    var html = "<table><thead><tr><th>Metric</th><th>Labels</th><th>Value</th></tr></thead><tbody>";
    rows.forEach(function (row) {
      html +=
        "<tr><td>" + escapeHtml(row.name) + "</td><td>" + escapeHtml(row.labels) +
        "</td><td>" + escapeHtml(row.value) + "</td></tr>";
    });
    html += "</tbody></table>";
    root.innerHTML = html;
  }

  function loadTelemetry() {
    fetch("/metrics")
      .then(function (res) { return res.text(); })
      .then(renderTelemetry)
      .catch(function (err) {
        document.getElementById("telemetry-root").innerHTML =
          "<div class=\\"empty-state\\">Failed to load telemetry: " + escapeHtml(err) + "</div>";
      });
  }

  // Routing policy panel — read-only view of config/routing-policy.yaml via
  // GET /routing-policy, same "summary surface loaded once on page load"
  // pattern as telemetry/model-catalog above.
  function renderRoutingPolicy(policy) {
    var root = document.getElementById("routing-policy-root");
    var html = "<div class=\\"strategy-status\\">cost preference: <strong>" +
      escapeHtml(policy.cost_preference) + "</strong> · headroom floor: <strong>" +
      escapeHtml(String(policy.headroom_floor)) + "</strong></div>";
    html += "<table><thead><tr><th>Task type</th><th>Provider weights</th></tr></thead><tbody>";
    Object.keys(policy.task_type_weights).forEach(function (taskType) {
      var weights = policy.task_type_weights[taskType];
      var parts = Object.keys(weights).map(function (provider) {
        return escapeHtml(provider) + ": " + escapeHtml(String(weights[provider]));
      });
      html += "<tr><td>" + escapeHtml(taskType) + "</td><td>" + parts.join(", ") + "</td></tr>";
    });
    html += "</tbody></table>";
    if (policy.experiments && policy.experiments.enabled) {
      var armParts = Object.keys(policy.experiments.arms).map(function (arm) {
        return escapeHtml(arm) + ": " + escapeHtml(String(policy.experiments.arms[arm].split));
      });
      html += "<div class=\\"reason\\">experiments enabled — arms: " + armParts.join(", ") + "</div>";
    } else {
      html += "<div class=\\"reason\\">experiments disabled</div>";
    }
    root.innerHTML = html;
  }

  function loadRoutingPolicy() {
    fetch("/routing-policy")
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok) {
          document.getElementById("routing-policy-root").innerHTML =
            "<div class=\\"empty-state\\">Failed to load routing policy: " +
            escapeHtml(result.body.message || result.body.error || "unknown error") + "</div>";
          return;
        }
        renderRoutingPolicy(result.body);
      })
      .catch(function (err) {
        document.getElementById("routing-policy-root").innerHTML =
          "<div class=\\"empty-state\\">Failed to load routing policy: " + escapeHtml(err) + "</div>";
      });
  }

  // Settings — theme + desktop icon (hdl-unified-dashboard /
  // hdl-desktop-icon-settings). Same "loaded once, not on the 5s poll"
  // reasoning as every other config panel above.
  var THEME_LABELS = { "mission-control": "Mission Control", "harbor-watch": "Harbor Watch", "terminal": "Terminal" };

  function renderThemePicker(data) {
    var picker = document.getElementById("theme-picker");
    picker.innerHTML = data.available
      .map(function (name) {
        var activeClass = name === data.active ? " active" : "";
        return "<button type=\\"button\\" class=\\"theme-option" + activeClass + "\\" data-theme-choice=\\"" +
          escapeHtml(name) + "\\">" + escapeHtml(THEME_LABELS[name] || name) + "</button>";
      })
      .join("");
  }

  function loadTheme() {
    fetch("/theme").then(function (res) { return res.json(); }).then(renderThemePicker);
  }

  document.getElementById("theme-picker").addEventListener("click", function (event) {
    var btn = event.target.closest("button[data-theme-choice]");
    if (!btn) return;
    var theme = btn.getAttribute("data-theme-choice");
    fetch("/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: theme })
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (!result.active) return;
        // Applied immediately, client-side -- no reload needed. Mission
        // Control needs the attribute REMOVED, not set to
        // "mission-control" (the CSS's bare :root already IS Mission
        // Control; a stray [data-theme="mission-control"] selector doesn't
        // even exist, so setting it would just silently do nothing wrong,
        // but removing it matches how the server-rendered HTML itself
        // decides whether to emit the attribute at all).
        if (result.active === "mission-control") {
          document.documentElement.removeAttribute("data-theme");
        } else {
          document.documentElement.setAttribute("data-theme", result.active);
        }
        renderThemePicker({ active: result.active, available: Object.keys(THEME_LABELS) });
      });
  });

  var ICON_LABELS = { "watchtower": "Watchtower", "routing-lanes": "Routing Mark", "signal-horn": "Signal Horn" };
  var ICON_GLYPHS = { "watchtower": "\\ud83d\\uddfc", "routing-lanes": "\\ud83d\\udd00", "signal-horn": "\\ud83d\\udcef" };

  function renderIconPicker(data) {
    var picker = document.getElementById("icon-picker");
    picker.innerHTML = data.available
      .map(function (name) {
        var activeClass = name === data.active ? " active" : "";
        return "<button type=\\"button\\" class=\\"icon-option" + activeClass + "\\" data-icon-choice=\\"" +
          escapeHtml(name) + "\\"><span class=\\"icon-glyph\\">" + (ICON_GLYPHS[name] || "") + "</span>" +
          escapeHtml(ICON_LABELS[name] || name) + "</button>";
      })
      .join("");
  }

  function loadIcon() {
    fetch("/desktop-icon").then(function (res) { return res.json(); }).then(renderIconPicker);
  }

  document.getElementById("icon-picker").addEventListener("click", function (event) {
    var btn = event.target.closest("button[data-icon-choice]");
    if (!btn) return;
    var icon = btn.getAttribute("data-icon-choice");
    fetch("/desktop-icon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ icon: icon })
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (!result.active) return;
        renderIconPicker({ active: result.active, available: Object.keys(ICON_LABELS) });
        // hdl-desktop-icon-settings: honest about the real Tauri v2/macOS
        // limitation -- there is no supported way to swap a running app's
        // Dock icon at runtime (confirmed via multiple open Tauri GitHub
        // issues, not assumed). The tray icon DOES update live on next
        // launch/refresh; the Dock icon needs an actual rebuild, same
        // "restart_required" pattern the Add lane form already uses.
        document.getElementById("icon-settings-note").textContent =
          "Preference saved. Tray icon updates next time you launch Heimdall; Dock icon needs a rebuild: cd app && cargo tauri build";
      });
  });

  loadRoutingStrategy();
  loadModelCatalog();
  loadTelemetry();
  loadRoutingPolicy();
  loadTheme();
  loadIcon();
  poll();
  setInterval(poll, 5000);
})();
</script>
</body>
</html>
`;
}
