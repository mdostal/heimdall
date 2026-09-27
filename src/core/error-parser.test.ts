import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCapSignal } from "./error-parser.js";

const NOW = new Date("2026-09-27T12:00:00.000Z");
// DEFAULT_RESET_MS fallback: no usable reset information.
const FALLBACK = "2026-10-04T12:00:00.000Z";

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null };
}

function resetAtFor(values: Record<string, string>): string | undefined {
  return parseClaudeCapSignal({ status: 429, headers: headers(values), body: {} }, NOW)?.reset_at;
}

const cases: Array<{ name: string; headers: Record<string, string>; expected: string }> = [
  { name: "relative x-ratelimit-reset is seconds from now", headers: { "x-ratelimit-reset": "60" }, expected: "2026-09-27T12:01:00.000Z" },
  { name: "epoch-seconds x-ratelimit-reset is absolute", headers: { "x-ratelimit-reset": "1790000000" }, expected: new Date(1_790_000_000_000).toISOString() },
  { name: "epoch-ms x-ratelimit-reset is absolute", headers: { "x-ratelimit-reset": "1790000000000" }, expected: new Date(1_790_000_000_000).toISOString() },
  { name: "retry-after in seconds", headers: { "retry-after": "120" }, expected: "2026-09-27T12:02:00.000Z" },
  { name: "retry-after as HTTP-date", headers: { "retry-after": "Sun, 27 Sep 2026 12:30:00 GMT" }, expected: "2026-09-27T12:30:00.000Z" },
  { name: "anthropic requests reset", headers: { "anthropic-ratelimit-requests-reset": "2026-09-27T12:05:00Z" }, expected: "2026-09-27T12:05:00.000Z" },
  { name: "anthropic tokens reset", headers: { "anthropic-ratelimit-tokens-reset": "2026-09-27T12:06:00Z" }, expected: "2026-09-27T12:06:00.000Z" },
  { name: "anthropic input-tokens reset", headers: { "anthropic-ratelimit-input-tokens-reset": "2026-09-27T12:07:00+00:00" }, expected: "2026-09-27T12:07:00.000Z" },
  { name: "anthropic output-tokens reset with offset", headers: { "anthropic-ratelimit-output-tokens-reset": "2026-09-27T07:08:00-05:00" }, expected: "2026-09-27T12:08:00.000Z" },
  {
    name: "several headers at once: latest wins",
    headers: {
      "x-ratelimit-reset": "30",
      "retry-after": "90",
      "anthropic-ratelimit-requests-reset": "2026-09-27T12:01:00Z",
      "anthropic-ratelimit-tokens-reset": "2026-09-27T12:10:00Z",
      "anthropic-ratelimit-output-tokens-reset": "2026-09-27T12:03:00Z",
    },
    expected: "2026-09-27T12:10:00.000Z",
  },
  { name: "garbage alongside a valid header is skipped", headers: { "x-ratelimit-reset": "soon", "retry-after": "45" }, expected: "2026-09-27T12:00:45.000Z" },
  { name: "garbage x-ratelimit-reset falls back", headers: { "x-ratelimit-reset": "soon" }, expected: FALLBACK },
  { name: "negative x-ratelimit-reset falls back", headers: { "x-ratelimit-reset": "-5" }, expected: FALLBACK },
  { name: "zero x-ratelimit-reset falls back", headers: { "x-ratelimit-reset": "0" }, expected: FALLBACK },
  { name: "negative retry-after falls back", headers: { "retry-after": "-5" }, expected: FALLBACK },
  { name: "garbage retry-after falls back", headers: { "retry-after": "later" }, expected: FALLBACK },
  { name: "garbage anthropic reset falls back", headers: { "anthropic-ratelimit-requests-reset": "not-a-date" }, expected: FALLBACK },
  { name: "numeric anthropic reset is not RFC 3339, falls back", headers: { "anthropic-ratelimit-tokens-reset": "60" }, expected: FALLBACK },
  { name: "all garbage at once falls back", headers: { "x-ratelimit-reset": "Infinity", "retry-after": "", "anthropic-ratelimit-tokens-reset": "xyz" }, expected: FALLBACK },
  { name: "no headers falls back", headers: {}, expected: FALLBACK },
];

for (const c of cases) {
  test(`reset headers: ${c.name}`, () => {
    assert.equal(resetAtFor(c.headers), c.expected);
  });
}

test("reset headers: an explicit body reset_at still wins over headers", () => {
  const signal = parseClaudeCapSignal(
    { status: 429, headers: headers({ "retry-after": "120" }), body: { error: { message: "rate limited", reset_at: "2026-09-28T00:00:00.000Z" } } },
    NOW,
  );
  assert.equal(signal?.reset_at, "2026-09-28T00:00:00.000Z");
});

test("reset headers: a CLI-style message still applies when headers are garbage", () => {
  const signal = parseClaudeCapSignal(
    { status: 429, headers: headers({ "x-ratelimit-reset": "soon" }), message: "limit reached, resets 7pm (UTC)" },
    NOW,
  );
  assert.equal(signal?.reset_at, "2026-09-27T19:00:00.000Z");
});
