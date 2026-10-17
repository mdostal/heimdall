import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderDashboardHtml } from "./dashboard.js";

// The dashboard's client JS lives inside one server-side template literal,
// where `\"` silently collapses to a bare `"` — a SyntaxError that kills the
// whole script (every lane disappears), and nothing type-checks it. PANT-823
// shipped exactly that; these tests run the real rendered script.

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

for (const theme of ["mission-control", "harbor-watch", "terminal"]) {
  for (const dismissed of [false, true]) {
    test(`PANT-823: every inline dashboard <script> parses (theme=${theme}, onboardingDismissed=${dismissed})`, () => {
      const scripts = inlineScripts(renderDashboardHtml(theme, dismissed));
      assert.ok(scripts.length > 0, "expected at least one inline <script>");
      for (const script of scripts) {
        assert.doesNotThrow(() => new vm.Script(script), SyntaxError);
      }
    });
  }
}

// A permissive stand-in for any DOM/browser object: every property is a
// callable stub, so the script's setup code (listeners, querySelector, ...)
// runs without a real DOM. Only innerHTML assignments are recorded.
function stub(written: Map<string, string>, id: string): unknown {
  const target = function () {} as unknown as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "innerHTML") return written.get(id) ?? "";
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "then") return undefined; // not a thenable
      return stub(written, `${id}.${String(prop)}`);
    },
    set(_t, prop, value) {
      if (prop === "innerHTML") written.set(id, String(value));
      return true;
    },
    apply() {
      return stub(written, `${id}()`);
    },
  });
}

test("PANT-823: never-probed and stale lanes render a grey 'no signal' badge; fresh lanes keep their status badge", async () => {
  const lanes = [
    { lane_id: "claude@never", provider: "claude", status: "down", signal_state: "never_probed", last_probed_at: null },
    { lane_id: "claude@stale", provider: "claude", status: "up", signal_state: "stale", last_probed_at: "2026-09-28T09:00:00.000Z" },
    { lane_id: "claude@fresh", provider: "claude", status: "down", signal_state: "fresh", last_probed_at: "2026-09-28T12:00:00.000Z" },
  ].map((lane) => ({
    reset_at: null, reason: null, error_code: null, last_updated: lane.last_probed_at ?? "1970-01-01T00:00:00.000Z",
    signal_source: "active_probe", manual_override: null, override_reason: null, credential_configured: true,
    manual_reset_at: null, model: "claude", credential_ref: lane.lane_id, priority: null, manual_headroom: null,
    manual_cost_tier: null, multica_agent_ids: [], ...lane,
  }));

  const written = new Map<string, string>();
  const document = new Proxy({}, {
    get(_t, prop) {
      if (prop === "getElementById") return (id: string) => stub(written, id);
      return stub(written, `document.${String(prop)}`);
    },
  });
  // Only GET /lanes answers; every other panel's request stays pending, so
  // this test exercises the lanes table alone.
  const fetch = (url: string) =>
    url === "/lanes" ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(lanes) }) : new Promise(() => {});
  const context = vm.createContext({
    document, fetch, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    window: stub(written, "window"), localStorage: stub(written, "localStorage"), navigator: stub(written, "navigator"),
  });

  for (const script of inlineScripts(renderDashboardHtml())) {
    new vm.Script(script).runInContext(context);
  }
  // fetch -> json -> render is a few microtask hops; wait on the result, not a fixed delay.
  for (let i = 0; i < 100 && !written.has("root"); i++) await new Promise((resolve) => setImmediate(resolve));

  const table = written.get("root") ?? "";
  const rowFor = (laneId: string) => table.split("<tr>").find((row) => row.includes(`<td>${laneId}</td>`)) ?? "";
  assert.ok(rowFor("claude@never"), `lanes table didn't render: ${table.slice(0, 200)}`);

  assert.match(rowFor("claude@never"), /class="badge badge-no-signal"[^>]*>no signal</);
  assert.match(rowFor("claude@stale"), /class="badge badge-no-signal"[^>]*>no signal \(stale\)</);
  assert.match(rowFor("claude@fresh"), /class="badge badge-down">down</);
  assert.doesNotMatch(rowFor("claude@never"), /badge-down/);
});
