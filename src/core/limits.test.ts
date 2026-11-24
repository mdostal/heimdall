// heimdall#142 slice 1: limits as first-class data and Claude per-model
// limit parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeLimit,
  effectiveLimit,
  isLimitKind,
  isModelScopedCap,
  limitFromClaudeCapSignal,
  parseModelAliases,
  resolveModelName,
  type LaneLimit,
} from "./limits.js";
import { extractLimitModel, parseClaudeCapSignal, parseCliStyleResetTime } from "./error-parser.js";
import { StateStore } from "./state-store.js";

const ALIASES = parseModelAliases("fable=claude-fable-5-2, Opus = claude-opus-5-5,broken,=x");
const FABLE_MESSAGE = "You've reached your Fable limit · resets Fri 1pm (America/Chicago). /upgrade or switch to Opus to continue.";

test("heimdall#142: parseModelAliases reads name=model pairs case-insensitively and skips malformed ones", () => {
  assert.deepEqual([...ALIASES.entries()], [
    ["fable", "claude-fable-5-2"],
    ["opus", "claude-opus-5-5"],
  ]);
  assert.equal(resolveModelName("FABLE", ALIASES), "claude-fable-5-2");
  assert.equal(resolveModelName("Sonnet", ALIASES), "sonnet", "an unmapped name stays as its lowercase display name");
  assert.equal(parseModelAliases(undefined).size, 0);
});

test("heimdall#142: isLimitKind accepts the five kinds and rejects an empty model", () => {
  for (const kind of ["five_hour", "weekly_all_models", "credits", "spend_cap", "weekly_model:claude-fable-5-2"]) {
    assert.equal(isLimitKind(kind), true, kind);
  }
  for (const kind of ["weekly_model:", "monthly", "", 3, null]) {
    assert.equal(isLimitKind(kind), false, String(kind));
  }
});

test("heimdall#142: extractLimitModel names the model and ignores account-wide limit words", () => {
  assert.equal(extractLimitModel(FABLE_MESSAGE), "fable");
  assert.equal(extractLimitModel("You've hit your weekly Opus limit"), "opus");
  assert.equal(extractLimitModel("You've hit your weekly limit"), null);
  assert.equal(extractLimitModel("You've hit your session limit"), null);
  assert.equal(extractLimitModel("You've reached your usage limit"), null);
});

test("heimdall#142: the Fable limit message parses as a model_limit with the provider's reset time", () => {
  const now = new Date("2026-11-15T15:00:00Z"); // Sunday
  const signal = parseClaudeCapSignal(new Error(FABLE_MESSAGE), now);
  assert.ok(signal);
  assert.equal(signal.kind, "model_limit");
  assert.equal(signal.model, "fable");
  assert.equal(signal.reset_at_known, true);
  assert.equal(signal.used_percent, null, "the message gives no percent, so it stays unknown");
  // Friday 2026-11-20 13:00 America/Chicago (CST, UTC-6) = 19:00Z.
  assert.equal(signal.reset_at, "2026-11-20T19:00:00.000Z");
  assert.equal(isModelScopedCap(signal), true);
});

test("heimdall#142: parseCliStyleResetTime understands a weekday reset", () => {
  const now = new Date("2026-11-15T15:00:00Z");
  assert.equal(parseCliStyleResetTime("resets Mon 9am (UTC)", now), "2026-11-16T09:00:00.000Z");
});

test("heimdall#142: limitFromClaudeCapSignal maps the Fable limit to weekly_model:<id> only", () => {
  const signal = parseClaudeCapSignal(new Error(FABLE_MESSAGE), new Date("2026-11-15T15:00:00Z"));
  assert.ok(signal);
  const limit = limitFromClaudeCapSignal(signal, ALIASES);
  assert.deepEqual(limit, {
    kind: "weekly_model:claude-fable-5-2",
    scope: "model",
    model: "claude-fable-5-2",
    state: "exhausted",
    used_percent: null,
    resets_at: "2026-11-20T19:00:00.000Z",
    reason: signal.reason,
  });
});

test("heimdall#142: an account-wide weekly limit and a session limit stay account-scoped", () => {
  const now = new Date("2026-11-15T15:00:00Z");
  const weekly = parseClaudeCapSignal(new Error("You've hit your weekly limit · resets Mon 9am (UTC)"), now);
  assert.ok(weekly);
  assert.equal(isModelScopedCap(weekly), false);
  const weeklyLimit = limitFromClaudeCapSignal(weekly, ALIASES);
  assert.equal(weeklyLimit?.kind, "weekly_all_models");
  assert.equal(weeklyLimit?.scope, "account");

  const session = parseClaudeCapSignal(new Error("You've hit your session limit · resets 3pm (UTC)"), now);
  assert.ok(session);
  assert.equal(limitFromClaudeCapSignal(session, ALIASES)?.kind, "five_hour");
});

test("heimdall#142: a limit message without a reset time records resets_at as unknown, never a guess", () => {
  const signal = parseClaudeCapSignal(new Error("You've reached your Fable limit"), new Date("2026-11-15T15:00:00Z"));
  assert.ok(signal);
  assert.equal(signal.reset_at_known, false);
  assert.equal(limitFromClaudeCapSignal(signal, ALIASES)?.resets_at, null);
});

test("heimdall#142: a plain rate limit is not a quota limit", () => {
  const signal = parseClaudeCapSignal({ status: 429, message: "rate_limit_error" });
  assert.ok(signal);
  assert.equal(limitFromClaudeCapSignal(signal, ALIASES), null);
});

function laneLimit(overrides: Partial<LaneLimit> = {}): LaneLimit {
  return {
    lane_id: "claude@a",
    kind: "weekly_model:claude-fable-5-2",
    scope: "model",
    model: "claude-fable-5-2",
    state: "exhausted",
    used_percent: null,
    resets_at: "2026-11-20T19:00:00.000Z",
    reason: "You've reached your Fable limit",
    source: "passive",
    observed_at: "2026-11-15T15:00:00.000Z",
    ...overrides,
  };
}

test("heimdall#142: effectiveLimit reads an exhausted limit as available once its reset time passes", () => {
  const limit = laneLimit();
  assert.equal(effectiveLimit(limit, new Date("2026-11-20T18:59:59Z")).state, "exhausted");
  assert.equal(effectiveLimit(limit, new Date("2026-11-20T19:00:00Z")).state, "available");
  assert.equal(effectiveLimit(laneLimit({ resets_at: null }), new Date("2027-01-01T00:00:00Z")).state, "exhausted",
    "no known reset time: stays exhausted until observed otherwise");
});

test("heimdall#142: describeLimit says unknown for numbers the provider did not give", () => {
  assert.equal(
    describeLimit(laneLimit({ resets_at: null })),
    "weekly_model:claude-fable-5-2: exhausted (usage unknown, reset time unknown, source passive)",
  );
});

test("heimdall#142: StateStore records, reads, keeps the newest and clears lane limits", () => {
  const store = new StateStore(":memory:");
  try {
    const signal = parseClaudeCapSignal(new Error(FABLE_MESSAGE), new Date("2026-11-15T15:00:00Z"));
    assert.ok(signal);
    const limit = limitFromClaudeCapSignal(signal, ALIASES);
    assert.ok(limit);
    assert.equal(store.recordLimit("claude@a", limit, "passive", "2026-11-15T15:00:00.000Z"), true);
    // An older observation arriving late does not overwrite a newer one.
    assert.equal(store.recordLimit("claude@a", { ...limit, state: "available" }, "active_probe", "2026-11-15T14:00:00.000Z"), false);

    const now = new Date("2026-11-16T00:00:00Z");
    const limits = store.getLimits("claude@a", now);
    assert.equal(limits.length, 1);
    assert.equal(limits[0]?.kind, "weekly_model:claude-fable-5-2");
    assert.equal(limits[0]?.state, "exhausted");
    assert.equal(limits[0]?.source, "passive");
    assert.equal(limits[0]?.used_percent, null);
    assert.deepEqual([...store.getAllLimits(now).keys()], ["claude@a"]);

    // After the provider's reset time it reads available.
    assert.equal(store.getLimits("claude@a", new Date("2026-11-21T00:00:00Z"))[0]?.state, "available");

    assert.equal(store.clearLimit("claude@a", "weekly_model:claude-fable-5-2"), true);
    assert.equal(store.clearLimit("claude@a", "weekly_model:claude-fable-5-2"), false);
    assert.deepEqual(store.getLimits("claude@a", now), []);
  } finally {
    store.close();
  }
});
