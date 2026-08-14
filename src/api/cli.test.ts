import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAsTable, formatAsJson, renderLanes, parseFormatFlag } from "./cli.js";
import { getLaneStatuses } from "./http-server.js";
import { LaneRegistry } from "../core/lane-registry.js";
import { StateStore } from "../core/state-store.js";
import { EnvCredentialSource } from "../core/credential-source.js";

function registryWithOneConfiguredLane(): LaneRegistry {
  return new LaneRegistry(
    [{ lane_id: "claude@mathew.dostal", provider: "claude", credential_ref: "CLAUDE_TOKEN" }],
    new EnvCredentialSource({ CLAUDE_TOKEN: "secret" }),
  );
}

test("parseFormatFlag defaults to json", () => {
  assert.equal(parseFormatFlag([]), "json");
  assert.equal(parseFormatFlag(["--other-flag"]), "json");
});

test("parseFormatFlag recognizes --format table", () => {
  assert.equal(parseFormatFlag(["--format", "table"]), "table");
});

test("an unrecognized --format value falls back to json rather than erroring", () => {
  assert.equal(parseFormatFlag(["--format", "yaml"]), "json");
});

test("formatAsJson matches getLaneStatuses' data exactly (no duplicated logic)", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const lanes = getLaneStatuses(registry, store);

  const json = formatAsJson(lanes);
  assert.deepEqual(JSON.parse(json), lanes);
  store.close();
});

test("formatAsTable renders a header row and one row per lane", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const lanes = getLaneStatuses(registry, store);

  const table = formatAsTable(lanes);
  const lines = table.split("\n");
  assert.equal(lines.length, 2); // header + 1 lane
  assert.match(lines[0], /LANE_ID/);
  assert.match(lines[1], /claude@mathew\.dostal/);
  store.close();
});

test("formatAsTable handles zero lanes without erroring", () => {
  assert.equal(formatAsTable([]), "No lanes configured.");
});

test("renderLanes dispatches to the right formatter", () => {
  const registry = registryWithOneConfiguredLane();
  const store = new StateStore(":memory:");
  const lanes = getLaneStatuses(registry, store);

  assert.equal(renderLanes(lanes, "json"), formatAsJson(lanes));
  assert.equal(renderLanes(lanes, "table"), formatAsTable(lanes));
  store.close();
});

// `runRouteCommand` test intentionally removed during hdl-routing-reconciliation —
// the `route` subcommand is rebuilt against the refactored routing-strategies
// interface in hdl-rr-03-scored-strategy-port, with its test restored there.

