import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeLanePipeline, type RefreshDeps } from "./lane-pipeline.js";
import { StateStore } from "./state-store.js";
import type { Lane } from "./lane-registry.js";

const CLAUDE_LANE: Lane = {
  lane_id: "claude@mathew.dostal",
  provider: "claude",
  credential_ref: "CLAUDE_TOKEN",
  credential: "sk-ant-fake",
};

const UNCONFIGURED_LANE: Lane = {
  lane_id: "claude@unconfigured",
  provider: "claude",
  credential_ref: "MISSING_TOKEN",
  credential: null,
};

function baseDeps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    now: () => "2026-07-25T12:00:00.000Z",
    lastPassiveResponse: () => null,
    ...overrides,
  };
}

function fetchReturning(status: number): typeof fetch {
  return (async (url: unknown) => {
    if (typeof url === "string" && url.includes("status.claude.com")) {
      return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
    } as unknown as Response;
  }) as typeof fetch;
}

function seedStore(): { store: StateStore; setup: () => void } {
  const store = new StateStore(":memory:");
  return {
    store,
    setup: () => {
      store.upsertLane({
        lane_id: CLAUDE_LANE.lane_id,
        provider: CLAUDE_LANE.provider,
        credential_ref: CLAUDE_LANE.credential_ref,
      });
    },
  };
}

test("end-to-end: fresh lane with no history escalates straight to an active probe (REQ-01/03)", async () => {
  const { store, setup } = seedStore();
  setup();
  const pipeline = new ClaudeLanePipeline(store, baseDeps({ fetchImpl: fetchReturning(200) }));

  await pipeline.refresh(CLAUDE_LANE);

  const status = store.getCurrentStatus(CLAUDE_LANE.lane_id);
  assert.equal(status?.status, "up");
  assert.equal(status?.signal_source, "active_probe");
});

test("end-to-end: a single down probe result downgrades to degraded, uncorroborated (REQ-03/04)", async () => {
  const { store, setup } = seedStore();
  setup();
  const pipeline = new ClaudeLanePipeline(store, baseDeps({ fetchImpl: fetchReturning(503) }));

  await pipeline.refresh(CLAUDE_LANE);

  const status = store.getCurrentStatus(CLAUDE_LANE.lane_id);
  assert.equal(status?.status, "degraded");
  assert.match(status?.reason ?? "", /awaiting corroboration/);
});

test("end-to-end: two consecutive down probe results corroborate into a trusted down (REQ-04)", async () => {
  const { store, setup } = seedStore();
  setup();
  const deps = baseDeps({
    fetchImpl: fetchReturning(503),
    now: () => "2026-07-25T12:00:00.000Z",
  });
  const pipeline = new ClaudeLanePipeline(store, deps);

  await pipeline.refresh(CLAUDE_LANE); // 1st: degraded, uncorroborated
  await pipeline.refresh(CLAUDE_LANE); // 2nd: same raw verdict -> corroborated

  const status = store.getCurrentStatus(CLAUDE_LANE.lane_id);
  assert.equal(status?.status, "down");
});

test("end-to-end: recent passive signal is used instead of escalating (REQ-01)", async () => {
  const { store, setup } = seedStore();
  setup();
  // Seed a recent passive entry so decideSignalSource treats it as fresh.
  store.recordStatus({
    lane_id: CLAUDE_LANE.lane_id,
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "passive",
    observed_at: "2026-07-25T11:59:55.000Z", // 5s before "now"
  });

  let fetchCalled = false;
  const deps = baseDeps({
    lastPassiveResponse: () => ({ ok: true, statusCode: 200 }),
    fetchImpl: (async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
    }) as typeof fetch,
  });
  const pipeline = new ClaudeLanePipeline(store, deps);

  await pipeline.refresh(CLAUDE_LANE);

  assert.equal(fetchCalled, false, "passive branch must not hit the network");
  const status = store.getCurrentStatus(CLAUDE_LANE.lane_id);
  assert.equal(status?.signal_source, "passive");
  assert.equal(status?.status, "up");
});

test("end-to-end: stale passive + recent public-status uses public-status (REQ-01/02)", async () => {
  const { store, setup } = seedStore();
  setup();
  store.recordStatus({
    lane_id: CLAUDE_LANE.lane_id,
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "passive",
    observed_at: "2026-07-25T11:00:00.000Z", // 1hr before "now" — stale
  });
  store.recordStatus({
    lane_id: CLAUDE_LANE.lane_id,
    status: "up",
    reset_at: null,
    reason: null,
    signal_source: "public_status",
    observed_at: "2026-07-25T11:59:40.000Z", // 20s before "now" — fresh
  });

  let probeCalled = false;
  const deps = baseDeps({
    fetchImpl: (async (url: unknown) => {
      if (typeof url === "string" && url.includes("api.anthropic.com")) probeCalled = true;
      return { ok: true, status: 200, json: async () => ({ components: [] }) } as Response;
    }) as typeof fetch,
  });
  const pipeline = new ClaudeLanePipeline(store, deps);

  await pipeline.refresh(CLAUDE_LANE);

  assert.equal(probeCalled, false, "must use public-status, not escalate to an active probe");
  const status = store.getCurrentStatus(CLAUDE_LANE.lane_id);
  assert.equal(status?.signal_source, "public_status");
});

test("end-to-end: missing credential reports down/unconfigured without any network call (REQ-07)", async () => {
  const store = new StateStore(":memory:");
  store.upsertLane({
    lane_id: UNCONFIGURED_LANE.lane_id,
    provider: UNCONFIGURED_LANE.provider,
    credential_ref: UNCONFIGURED_LANE.credential_ref,
  });

  let fetchCalled = false;
  const deps = baseDeps({
    fetchImpl: (async () => {
      fetchCalled = true;
      throw new Error("must not be called");
    }) as typeof fetch,
  });
  const pipeline = new ClaudeLanePipeline(store, deps);

  await pipeline.refresh(UNCONFIGURED_LANE);

  assert.equal(fetchCalled, false);
  const status = store.getCurrentStatus(UNCONFIGURED_LANE.lane_id);
  assert.equal(status?.status, "down");
  assert.match(status?.reason ?? "", /no credential available/);
});
