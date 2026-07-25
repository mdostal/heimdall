import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideSignalSource,
  resolveWithCorroboration,
  requiresCorroboration,
} from "./escalation.js";

const NOW = "2026-07-25T12:00:00.000Z";

test("fresh passive signal — no escalation", () => {
  const decision = decideSignalSource({
    now: NOW,
    passiveSignalAt: "2026-07-25T11:59:50.000Z", // 10s ago
    publicStatusSignalAt: null,
    passiveStalenessMs: 30_000,
    publicStatusStalenessMs: 60_000,
  });
  assert.deepEqual(decision, { action: "use-passive" });
});

test("stale passive + fresh public-status — no escalation", () => {
  const decision = decideSignalSource({
    now: NOW,
    passiveSignalAt: "2026-07-25T11:59:00.000Z", // 60s ago — stale
    publicStatusSignalAt: "2026-07-25T11:59:30.000Z", // 30s ago — fresh
    passiveStalenessMs: 30_000,
    publicStatusStalenessMs: 60_000,
  });
  assert.deepEqual(decision, { action: "use-public-status" });
});

test("both stale — escalate to probe", () => {
  const decision = decideSignalSource({
    now: NOW,
    passiveSignalAt: "2026-07-25T11:58:00.000Z", // 120s ago
    publicStatusSignalAt: "2026-07-25T11:58:00.000Z", // 120s ago
    passiveStalenessMs: 30_000,
    publicStatusStalenessMs: 60_000,
  });
  assert.deepEqual(decision, { action: "escalate-to-probe" });
});

test("no passive signal at all — falls back to public-status, doesn't assume down", () => {
  const decision = decideSignalSource({
    now: NOW,
    passiveSignalAt: null,
    publicStatusSignalAt: "2026-07-25T11:59:50.000Z",
    passiveStalenessMs: 30_000,
    publicStatusStalenessMs: 60_000,
  });
  assert.deepEqual(decision, { action: "use-public-status" });
});

test("no signals at all — escalates rather than assuming any particular state", () => {
  const decision = decideSignalSource({
    now: NOW,
    passiveSignalAt: null,
    publicStatusSignalAt: null,
    passiveStalenessMs: 30_000,
    publicStatusStalenessMs: 60_000,
  });
  assert.deepEqual(decision, { action: "escalate-to-probe" });
});

test("requiresCorroboration is true only for down/out_of_credit", () => {
  assert.equal(requiresCorroboration("down"), true);
  assert.equal(requiresCorroboration("out_of_credit"), true);
  assert.equal(requiresCorroboration("up"), false);
  assert.equal(requiresCorroboration("degraded"), false);
});

test("up/degraded verdicts pass straight through, no corroboration needed", () => {
  assert.deepEqual(resolveWithCorroboration({ latestVerdict: "up", priorVerdict: null }), {
    verdict: "up",
    corroborated: true,
  });
});

test("a first-time down verdict (no prior) is downgraded to degraded, not corroborated", () => {
  const result = resolveWithCorroboration({ latestVerdict: "down", priorVerdict: null });
  assert.deepEqual(result, { verdict: "degraded", corroborated: false });
});

test("a repeated down verdict (matches prior) is corroborated and trusted", () => {
  const result = resolveWithCorroboration({ latestVerdict: "down", priorVerdict: "down" });
  assert.deepEqual(result, { verdict: "down", corroborated: true });
});

test("out_of_credit followed by a different verdict is not corroborated", () => {
  const result = resolveWithCorroboration({ latestVerdict: "out_of_credit", priorVerdict: "up" });
  assert.deepEqual(result, { verdict: "degraded", corroborated: false });
});
