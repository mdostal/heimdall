import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultEnabledModelIds } from "./model-recency.js";
import type { RawModelEntry } from "./signal-sources/model-list/claude.js";

function entry(id: string, createdAt: string | null): RawModelEntry {
  return { id, createdAt };
}

test("claude/codex: returns the top-N most recently created entries, not an arbitrary subset", () => {
  const entries = [
    entry("model-oldest", "2024-01-01T00:00:00Z"),
    entry("model-newest", "2026-08-01T00:00:00Z"),
    entry("model-middle", "2025-06-01T00:00:00Z"),
  ];
  const enabled = defaultEnabledModelIds("claude", entries);
  assert.ok(enabled.has("model-newest"));
  assert.ok(enabled.has("model-middle"));
  assert.ok(enabled.has("model-oldest")); // window (5) is larger than this list — all 3 fit
});

test("claude/codex: a window smaller than the list excludes the oldest entries", () => {
  const entries = Array.from({ length: 8 }, (_, i) =>
    entry(`model-${i}`, new Date(2026, 0, i + 1).toISOString()),
  );
  const enabled = defaultEnabledModelIds("codex", entries);
  assert.equal(enabled.size, 5);
  assert.ok(enabled.has("model-7"), "the most recently created entry must be included");
  assert.ok(!enabled.has("model-0"), "the oldest entry must be excluded once the window is full");
});

test("kimi: every createdAt null across the board -> enable ALL entries (no signal, never guess a subset)", () => {
  const entries = [entry("kimi-a", null), entry("kimi-b", null), entry("kimi-c", null)];
  const enabled = defaultEnabledModelIds("kimi", entries);
  assert.deepEqual([...enabled].sort(), ["kimi-a", "kimi-b", "kimi-c"]);
});

test("kimi: createdAt present -> behaves like the claude/codex top-N case", () => {
  const entries = Array.from({ length: 8 }, (_, i) => entry(`kimi-${i}`, new Date(2026, 0, i + 1).toISOString()));
  const enabled = defaultEnabledModelIds("kimi", entries);
  assert.equal(enabled.size, 5);
  assert.ok(enabled.has("kimi-7"));
});

test("gemini: only the highest-generation entries are included, never an older generation", () => {
  const entries = [
    entry("gemini-2.5-pro", null),
    entry("gemini-2.5-flash", null),
    entry("gemini-3-pro-preview", null),
    entry("gemini-3-flash-preview", null),
  ];
  const enabled = defaultEnabledModelIds("gemini", entries);
  assert.deepEqual([...enabled].sort(), ["gemini-3-flash-preview", "gemini-3-pro-preview"]);
  assert.ok(!enabled.has("gemini-2.5-pro"), "an older generation must never be included alongside a newer one");
});

test("gemini: an id that doesn't match the generation pattern defaults to INCLUDED, not silently excluded", () => {
  const entries = [entry("gemini-3-pro-preview", null), entry("some-unrecognized-model-name", null)];
  const enabled = defaultEnabledModelIds("gemini", entries);
  assert.ok(enabled.has("gemini-3-pro-preview"));
  assert.ok(enabled.has("some-unrecognized-model-name"), "unparseable ids must default to included (safe-open)");
});

test("an empty entries array for any provider returns an empty set without throwing", () => {
  assert.deepEqual(defaultEnabledModelIds("claude", []), new Set());
  assert.deepEqual(defaultEnabledModelIds("gemini", []), new Set());
  assert.deepEqual(defaultEnabledModelIds("kimi", []), new Set());
  assert.deepEqual(defaultEnabledModelIds("codex", []), new Set());
});
