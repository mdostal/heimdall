import { test } from "node:test";
import assert from "node:assert/strict";
import { LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import { EnvCredentialSource } from "../core/credential-source.js";
import { renderMetrics } from "./metrics.js";

test("hdl-ot-03: renderMetrics output is well-formed Prometheus text exposition format", () => {
  const registry = new LaneRegistry(
    [{ lane_id: "claude@x", provider: "claude", credential_ref: "C" }],
    new EnvCredentialSource({ C: "secret" }),
  );
  const store = new StateStore(":memory:");
  store.recordTelemetryEvent("actuation_result", { provider: "claude", action: "disable", success: "true" });

  const body = renderMetrics(registry, store);
  const lines = body.trimEnd().split("\n").filter((line) => line.length > 0);

  let pendingHelp: string | null = null;
  let pendingType: string | null = null;
  for (const line of lines) {
    if (line.startsWith("# HELP ")) {
      pendingHelp = line.split(" ")[2];
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const parts = line.split(" ");
      pendingType = parts[2];
      assert.equal(parts[2], pendingHelp, "TYPE must immediately follow HELP for the same metric family");
      assert.ok(["counter", "gauge"].includes(parts[3]), `unexpected metric type: ${parts[3]}`);
      continue;
    }
    // A metric sample line — must start with the most recently declared family name.
    assert.ok(pendingType && line.startsWith(pendingType), `sample line "${line}" is not preceded by a matching HELP/TYPE pair`);
    assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.]+$/, `sample line "${line}" is not valid Prometheus exposition format`);
  }

  store.close();
});

test("hdl-ot-03: renderMetrics never crashes on a completely empty store", () => {
  const registry = new LaneRegistry([], new EnvCredentialSource({}));
  const store = new StateStore(":memory:");
  assert.doesNotThrow(() => renderMetrics(registry, store));
  store.close();
});
