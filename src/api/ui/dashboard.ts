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

export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heimdall — Lane Status</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 2rem;
    max-width: 1180px;
  }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; margin: 0 0 0.75rem; }
  .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid rgba(128, 128, 128, 0.3);
    font-size: 0.9rem;
    vertical-align: middle;
  }
  th { font-weight: 600; color: #888; }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    color: #fff;
  }
  .badge-up { background: #2ea043; }
  .badge-degraded { background: #bf8700; }
  .badge-down { background: #cf222e; }
  .badge-out_of_credit { background: #6639ba; }
  .override-badge {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    color: #fff;
    background: #b35900;
  }
  .chip {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid rgba(128, 128, 128, 0.4);
  }
  .chip-missing { color: #cf222e; border-color: #cf222e; }
  .error-code-chip {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    background: rgba(128, 128, 128, 0.15);
    color: #888;
  }
  .empty-state { color: #888; padding: 2rem 0; }
  .reason { color: #888; font-size: 0.85rem; }
  .gateway-header td {
    background: rgba(128, 128, 128, 0.08);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #666;
    padding-top: 0.75rem;
  }
  .override-controls button, .reset-at-controls button {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    margin-right: 0.25rem;
    border: 1px solid rgba(128, 128, 128, 0.4);
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }
  .override-controls button.active {
    border-color: currentColor;
    font-weight: 600;
  }
  .override-reason-input {
    display: block;
    font-size: 0.75rem;
    padding: 0.15rem 0.35rem;
    margin-top: 0.3rem;
    width: 12rem;
    max-width: 100%;
    border: 1px solid rgba(128, 128, 128, 0.4);
    border-radius: 4px;
    background: transparent;
    color: inherit;
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
  }
  .panel {
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 8px;
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
    border: 1px solid rgba(128, 128, 128, 0.4);
    border-radius: 4px;
    background: transparent;
    color: inherit;
  }
  .panel select {
    flex: 0 1 220px;
  }
  .panel button[type="submit"], .panel button[type="button"] {
    padding: 0.4rem 1rem;
    font-size: 0.85rem;
    border: 1px solid currentColor;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .strategy-status { font-size: 0.85rem; color: #888; margin-bottom: 0.6rem; }
  .model-provider-heading {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #888;
    margin: 0.9rem 0 0.35rem;
  }
  .model-provider-heading:first-child { margin-top: 0; }
  .model-catalog-table td { padding: 0.3rem 0.5rem; font-size: 0.85rem; }
  .model-catalog-table label { display: flex; align-items: center; gap: 0.35rem; cursor: pointer; }
  .model-created-at { color: #888; font-size: 0.78rem; margin-left: 0.4rem; }
  .banner {
    margin-top: 0.75rem;
    padding: 0.6rem 0.8rem;
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .banner-ok { background: rgba(46, 160, 67, 0.15); border: 1px solid #2ea043; }
  .banner-error { background: rgba(207, 34, 46, 0.15); border: 1px solid #cf222e; }
  .banner code {
    font-family: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
    background: rgba(128, 128, 128, 0.2);
    padding: 0.05em 0.4em;
    border-radius: 3px;
  }
</style>
</head>
<body>
  <h1>Heimdall — Lane Status <a href="/docs" style="font-size:0.6em;font-weight:400;">Docs &rarr;</a></h1>
  <div class="subtitle">Polls <code>GET /lanes</code> every 5s · manual overrides route through the same ControlAdapter Heimdall already uses for automatic sensing</div>

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

  function render(lanes) {
    var root = document.getElementById("root");
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
    var html = "";
    Object.keys(byProvider).sort().forEach(function (provider) {
      html += "<div class=\\"model-provider-heading\\">" + escapeHtml(provider) + "</div>";
      html += "<table class=\\"model-catalog-table\\"><tbody>";
      byProvider[provider].forEach(function (entry) {
        var checked = entry.enabled ? " checked" : "";
        var createdAt = entry.provider_created_at
          ? "<span class=\\"model-created-at\\">" + escapeHtml(entry.provider_created_at) + "</span>"
          : "";
        html +=
          "<tr><td><label>" +
          "<input type=\\"checkbox\\" data-provider=\\"" + escapeHtml(entry.provider) + "\\" data-model=\\"" + escapeHtml(entry.model_id) + "\\"" + checked + ">" +
          escapeHtml(entry.model_id) + createdAt +
          "</label></td></tr>";
      });
      html += "</tbody></table>";
    });
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

  loadRoutingStrategy();
  loadModelCatalog();
  loadTelemetry();
  loadRoutingPolicy();
  poll();
  setInterval(poll, 5000);
})();
</script>
</body>
</html>
`;
}
