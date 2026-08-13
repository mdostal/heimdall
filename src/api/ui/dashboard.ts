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
  .empty-state { color: #888; padding: 2rem 0; }
  .reason { color: #888; font-size: 0.85rem; }
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
  .panel input {
    flex: 1 1 140px;
    padding: 0.4rem 0.5rem;
    font-size: 0.85rem;
    border: 1px solid rgba(128, 128, 128, 0.4);
    border-radius: 4px;
    background: transparent;
    color: inherit;
  }
  .panel button[type="submit"] {
    padding: 0.4rem 1rem;
    font-size: 0.85rem;
    border: 1px solid currentColor;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
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
  <h1>Heimdall — Lane Status</h1>
  <div class="subtitle">Polls <code>GET /lanes</code> every 5s · manual overrides route through the same ControlAdapter Heimdall already uses for automatic sensing</div>

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
    return (
      "<span class=\\"override-controls\\">" +
      btn("enabled", "Enable") + btn("disabled", "Disable") + btn("auto", "Auto") +
      "</span>"
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

  function renderRow(lane) {
    var badgeClass = "badge badge-" + escapeHtml(lane.status);
    var label = BADGE_LABEL[lane.status] || lane.status;
    return (
      "<tr>" +
      "<td>" + escapeHtml(lane.lane_id) + "</td>" +
      "<td>" + escapeHtml(lane.provider) + "</td>" +
      "<td><span class=\\"" + badgeClass + "\\">" + escapeHtml(label) + "</span>" + overrideBadge(lane.manual_override) + "</td>" +
      "<td>" + tokenChip(lane) + "</td>" +
      "<td class=\\"reason\\">" + escapeHtml(lane.reason) + "</td>" +
      "<td>" + resetAtCell(lane) + "</td>" +
      "<td>" + escapeHtml(lane.last_updated) + "</td>" +
      "<td>" + escapeHtml(lane.signal_source) + "</td>" +
      "<td>" + overrideControls(lane) + "</td>" +
      "</tr>"
    );
  }

  function render(lanes) {
    var root = document.getElementById("root");
    if (!lanes || lanes.length === 0) {
      root.innerHTML = "<div class=\\"empty-state\\">No lanes declared.</div>";
      return;
    }
    var rows = lanes.map(renderRow).join("");
    root.innerHTML =
      "<table>" +
      "<thead><tr>" +
      "<th>Lane</th><th>Provider</th><th>Status</th><th>Token</th><th>Reason</th>" +
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
      overrideBtn.disabled = true;
      fetch("/lanes/" + encodeURIComponent(laneId) + "/override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: state })
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

  poll();
  setInterval(poll, 5000);
})();
</script>
</body>
</html>
`;
}
