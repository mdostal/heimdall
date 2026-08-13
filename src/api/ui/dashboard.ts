// Read-only live lane-status dashboard — first vertical slice of the
// standalone-mode UI requirement (has_ui: true, .pHive/project-profile.yaml).
// Self-contained HTML/CSS/JS: no build step, no framework, no new npm
// dependency, no external network calls — a pure consumer of the existing
// GET /lanes JSON endpoint. See docs/decisions/DEC-hdl-reason-aware-recovery.md
// item 3 and .pHive/epics/hdl-lane-status-ui/docs/design-discussion.md.
//
// Manual disable/enable, add-lane, and MCP agent-tooling are explicitly
// deferred to follow-up epics — this page only renders what GET /lanes
// already returns.

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
    max-width: 960px;
  }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid rgba(128, 128, 128, 0.3);
    font-size: 0.9rem;
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
  .empty-state { color: #888; padding: 2rem 0; }
  .reason { color: #888; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>Heimdall — Lane Status</h1>
  <div class="subtitle">Read-only live view · polls <code>GET /lanes</code> every 5s</div>
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

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderRow(lane) {
    var badgeClass = "badge badge-" + escapeHtml(lane.status);
    var label = BADGE_LABEL[lane.status] || lane.status;
    return (
      "<tr>" +
      "<td>" + escapeHtml(lane.lane_id) + "</td>" +
      "<td>" + escapeHtml(lane.provider) + "</td>" +
      "<td><span class=\\"" + badgeClass + "\\">" + escapeHtml(label) + "</span></td>" +
      "<td class=\\"reason\\">" + escapeHtml(lane.reason) + "</td>" +
      "<td>" + escapeHtml(formatResetAt(lane.reset_at)) + "</td>" +
      "<td>" + escapeHtml(lane.last_updated) + "</td>" +
      "<td>" + escapeHtml(lane.signal_source) + "</td>" +
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
      "<th>Lane</th><th>Provider</th><th>Status</th><th>Reason</th>" +
      "<th>Reset at</th><th>Last updated</th><th>Signal source</th>" +
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

  poll();
  setInterval(poll, 5000);
})();
</script>
</body>
</html>
`;
}
