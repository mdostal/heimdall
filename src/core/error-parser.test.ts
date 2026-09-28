import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCapSignal, parseTryAgainAtResetTime, type ClaudeCapKind } from "./error-parser.js";
import { ERROR_CODES, type ErrorCode } from "./status-model.js";
import { probeClaudeLane, probeClaudeSubscriptionLane } from "./signal-sources/active-probe/claude.js";
import { probeCodexLane } from "./signal-sources/active-probe/codex.js";

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

// ---------------------------------------------------------------------------
// Table-driven classification from real provider error strings (PANT-825).
//
// parseClaudeCapSignal only answers "is this a Claude cap, and which kind";
// the normalized ErrorCode is assigned by the probes that call it (Claude CLI
// + API) or share its reset helpers (Codex). So the ErrorCode table drives the
// probes with raw provider output and asserts the code AND the parsed reset_at
// together — the pair PANT-729 got wrong (a weekly cap read as auth_failed).
// ---------------------------------------------------------------------------

// Verbatim shapes: Claude Code CLI stderr, Anthropic / OpenAI HTTP error
// bodies (docs.anthropic.com/api/errors, platform.openai.com/docs/guides/error-codes),
// and the Codex usage-limit text quoted in signal-inventory.md.
const CLAUDE_WEEKLY_CLI = "You've hit your weekly limit · resets 7pm (America/Chicago)";
// Claude Code 2.1.283 builds this from "You've hit your " + "session limit".
const CLAUDE_SESSION_CLI = "You've hit your session limit · resets 3pm (America/Chicago)";
const CLAUDE_AUTH_CLI = "Failed to authenticate. API Error: 401 OAuth access token is invalid.";
const CODEX_USAGE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at Oct 13th, 2026 8:25 PM.";

function anthropicError(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

function openAiError(code: string, message: string) {
  return { error: { message, type: code, param: null, code } };
}

const capCases: Array<{ name: string; input: unknown; kind: ClaudeCapKind | null; reset_at?: string }> = [
  {
    name: "Claude CLI weekly limit reads its reset time (7pm Chicago = 00:00Z next day)",
    input: new Error(CLAUDE_WEEKLY_CLI),
    kind: "weekly_limit",
    reset_at: "2026-09-28T00:00:00.000Z",
  },
  {
    name: "Claude CLI weekly limit whose reset time already passed today rolls a week forward",
    input: new Error("You've hit your weekly limit · resets 6am (America/Chicago)"),
    kind: "weekly_limit",
    reset_at: "2026-10-04T11:00:00.000Z",
  },
  {
    name: "Claude CLI 5-hour session limit reads its reset time (3pm Chicago = 20:00Z)",
    input: new Error(CLAUDE_SESSION_CLI),
    kind: "session_limit",
    reset_at: "2026-09-27T20:00:00.000Z",
  },
  {
    name: "Claude CLI session limit whose reset time already passed today rolls a day forward",
    input: new Error("You've hit your session limit · resets 6am (America/Chicago)"),
    kind: "session_limit",
    reset_at: "2026-09-28T11:00:00.000Z",
  },
  {
    name: "Claude CLI '5-hour limit reached' with no timezone falls back to five hours",
    input: new Error("5-hour limit reached ∙ resets 3pm"),
    kind: "session_limit",
    reset_at: "2026-09-27T17:00:00.000Z",
  },
  {
    name: "older Claude CLI 'usage limit reached|<epoch>' reads the epoch",
    input: new Error("Claude AI usage limit reached|1790000000"),
    kind: "session_limit",
    reset_at: new Date(1_790_000_000_000).toISOString(),
  },
  {
    name: "Anthropic 429 whose message names a weekly limit",
    input: { status: 429, body: anthropicError("rate_limit_error", "You have reached your weekly usage limit") },
    kind: "weekly_limit",
    reset_at: FALLBACK,
  },
  {
    name: "Anthropic 429 per-minute rate limit takes reset_at from the header",
    input: {
      status: 429,
      headers: headers({ "anthropic-ratelimit-requests-reset": "2026-09-27T12:00:30Z", "retry-after": "30" }),
      body: anthropicError("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"),
    },
    kind: "rate_limit",
    reset_at: "2026-09-27T12:00:30.000Z",
  },
  {
    name: "status nested under response (SDK error shape)",
    input: { response: { status: 429, headers: headers({ "retry-after": "10" }), body: anthropicError("rate_limit_error", "rate limited") } },
    kind: "rate_limit",
    reset_at: "2026-09-27T12:00:10.000Z",
  },
  { name: "Claude CLI invalid OAuth token", input: new Error(CLAUDE_AUTH_CLI), kind: "oauth_expired", reset_at: FALLBACK },
  {
    name: "Anthropic 401 expired OAuth token",
    input: { status: 401, body: anthropicError("authentication_error", "OAuth token has expired. Please obtain a new token or refresh your existing token.") },
    kind: "oauth_expired",
    reset_at: FALLBACK,
  },
  { name: "Anthropic 401 bad API key is not a cap", input: { status: 401, body: anthropicError("authentication_error", "invalid x-api-key") }, kind: null },
  { name: "Anthropic 529 overloaded is not a cap", input: { status: 529, body: anthropicError("overloaded_error", "Overloaded") }, kind: null },
  { name: "Anthropic 500 api_error is not a cap", input: { status: 500, body: anthropicError("api_error", "Internal server error") }, kind: null },
  { name: "network failure is not a cap", input: new TypeError("fetch failed"), kind: null },
  { name: "garbage string", input: "¯\\_(ツ)_/¯", kind: null },
  { name: "null", input: null, kind: null },
  { name: "number", input: 429, kind: null },
  { name: "empty object", input: {}, kind: null },
];

for (const c of capCases) {
  test(`cap signal: ${c.name}`, () => {
    const signal = parseClaudeCapSignal(c.input, NOW);
    assert.equal(signal?.kind ?? null, c.kind);
    if (c.reset_at !== undefined) assert.equal(signal?.reset_at, c.reset_at);
  });
}

// --- ErrorCode, end to end through the probes --------------------------------

function fakeResponse(status: number, body?: unknown, responseHeaders: Record<string, string> = {}): Response {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return new Response(status === 204 || text === "" ? null : text, { status, headers: responseHeaders });
}

function respondWith(status: number, body?: unknown, responseHeaders?: Record<string, string>): typeof fetch {
  return (async () => fakeResponse(status, body, responseHeaders)) as typeof fetch;
}

function failFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 104.18.0.1:443") });
  }) as typeof fetch;
}

function cliFailsWith(message: string) {
  return {
    run: async () => {
      throw new Error(message);
    },
  };
}

type Probe = () => Promise<{ error_code: ErrorCode | null; reset_at: string | null }>;

const errorCodeCases: Array<{ name: string; probe: Probe; code: ErrorCode; reset_at: string | null }> = [
  // Claude subscription (CLI) — the PANT-729 path.
  {
    name: "Claude CLI weekly limit → quota_exceeded with the CLI's reset time, not auth_failed",
    probe: () => probeClaudeSubscriptionLane("sk-ant-oat01-x", cliFailsWith(CLAUDE_WEEKLY_CLI)),
    code: "quota_exceeded",
    reset_at: "2026-09-28T00:00:00.000Z",
  },
  {
    name: "Claude CLI 5-hour session limit → quota_exceeded with the CLI's reset time, not auth_failed",
    probe: () => probeClaudeSubscriptionLane("sk-ant-oat01-x", cliFailsWith(CLAUDE_SESSION_CLI)),
    code: "quota_exceeded",
    reset_at: "2026-09-27T20:00:00.000Z",
  },
  {
    name: "Claude CLI invalid OAuth token → auth_failed",
    probe: () => probeClaudeSubscriptionLane("sk-ant-oat01-x", cliFailsWith(CLAUDE_AUTH_CLI)),
    code: "auth_failed",
    reset_at: null,
  },
  // Claude API key (HTTP).
  {
    name: "Anthropic 429 rate_limit_error → rate_limit with the requests-reset header",
    probe: () =>
      probeClaudeLane(
        "sk-ant-api03-x",
        respondWith(429, anthropicError("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), {
          "anthropic-ratelimit-requests-reset": "2026-09-27T12:00:30Z",
          "retry-after": "30",
        }),
      ),
    code: "rate_limit",
    reset_at: "2026-09-27T12:00:30Z",
  },
  {
    name: "Anthropic 429 with only retry-after → rate_limit, reset_at = now + retry-after",
    probe: () => probeClaudeLane("sk-ant-api03-x", respondWith(429, anthropicError("rate_limit_error", "rate limited"), { "retry-after": "45" })),
    code: "rate_limit",
    reset_at: "2026-09-27T12:00:45.000Z",
  },
  {
    name: "Anthropic 429 naming a weekly limit → quota_exceeded",
    probe: () =>
      probeClaudeLane(
        "sk-ant-api03-x",
        respondWith(429, anthropicError("rate_limit_error", "You have reached your weekly usage limit"), {
          "anthropic-ratelimit-tokens-reset": "2026-10-01T00:00:00Z",
        }),
      ),
    code: "quota_exceeded",
    reset_at: "2026-10-01T00:00:00.000Z",
  },
  {
    name: "Anthropic 429 with a non-JSON body still → rate_limit",
    probe: () => probeClaudeLane("sk-ant-api03-x", respondWith(429, "<html>Too Many Requests</html>", { "retry-after": "5" })),
    code: "rate_limit",
    reset_at: "2026-09-27T12:00:05.000Z",
  },
  {
    name: "Anthropic 402 → billing_error",
    probe: () => probeClaudeLane("sk-ant-api03-x", respondWith(402, anthropicError("billing_error", "Your credit balance is too low to access the Anthropic API."))),
    code: "billing_error",
    reset_at: null,
  },
  {
    name: "Anthropic 401 invalid x-api-key → auth_failed",
    probe: () => probeClaudeLane("sk-ant-api03-x", respondWith(401, anthropicError("authentication_error", "invalid x-api-key"))),
    code: "auth_failed",
    reset_at: null,
  },
  {
    name: "Anthropic 403 permission_error → auth_failed",
    probe: () => probeClaudeLane("sk-ant-api03-x", respondWith(403, anthropicError("permission_error", "Your API key does not have permission to use the specified resource."))),
    code: "auth_failed",
    reset_at: null,
  },
  {
    name: "Anthropic 529 overloaded_error → server_error",
    probe: () => probeClaudeLane("sk-ant-api03-x", respondWith(529, anthropicError("overloaded_error", "Overloaded"))),
    code: "server_error",
    reset_at: null,
  },
  {
    name: "Anthropic 500 api_error → server_error",
    probe: () => probeClaudeLane("sk-ant-api03-x", respondWith(500, anthropicError("api_error", "Internal server error"))),
    code: "server_error",
    reset_at: null,
  },
  {
    name: "Anthropic unreachable (ECONNREFUSED) → network_error",
    probe: () => probeClaudeLane("sk-ant-api03-x", failFetch()),
    code: "network_error",
    reset_at: null,
  },
  {
    name: "Anthropic 404 not_found_error → unknown",
    probe: () => probeClaudeLane("sk-ant-api03-x", respondWith(404, anthropicError("not_found_error", "Not found"))),
    code: "unknown",
    reset_at: null,
  },
  // Codex / OpenAI (HTTP).
  {
    name: "Codex 429 usage limit → quota_exceeded, reset_at from retry-after",
    probe: () => probeCodexLane("sk-proj-x", respondWith(429, openAiError("usage_limit_reached", CODEX_USAGE_LIMIT), { "retry-after": "3600" })),
    code: "quota_exceeded",
    reset_at: "2026-09-27T13:00:00.000Z",
  },
  {
    name: "OpenAI 429 insufficient_quota → billing_error",
    probe: () =>
      probeCodexLane(
        "sk-proj-x",
        respondWith(429, openAiError("insufficient_quota", "You exceeded your current quota, please check your plan and billing details.")),
      ),
    code: "billing_error",
    reset_at: null,
  },
  {
    name: "OpenAI 429 rate_limit_exceeded → rate_limit, reset_at = now + retry-after",
    probe: () =>
      probeCodexLane(
        "sk-proj-x",
        respondWith(429, openAiError("rate_limit_exceeded", "Rate limit reached for gpt-5 in organization org-x on requests per min (RPM): Limit 500, Used 500, Requested 1."), {
          "retry-after": "20",
        }),
      ),
    code: "rate_limit",
    reset_at: "2026-09-27T12:00:20.000Z",
  },
  {
    name: "OpenAI 429 with garbage body and garbage retry-after → rate_limit, reset_at null",
    probe: () => probeCodexLane("sk-proj-x", respondWith(429, "not json", { "retry-after": "soon" })),
    code: "rate_limit",
    reset_at: null,
  },
  {
    name: "OpenAI 401 incorrect API key → auth_failed",
    probe: () => probeCodexLane("sk-proj-x", respondWith(401, openAiError("invalid_api_key", "Incorrect API key provided: sk-proj-x."))),
    code: "auth_failed",
    reset_at: null,
  },
  {
    name: "OpenAI 503 overloaded → server_error",
    probe: () => probeCodexLane("sk-proj-x", respondWith(503, openAiError("server_error", "The server is overloaded or not ready yet."))),
    code: "server_error",
    reset_at: null,
  },
  {
    name: "OpenAI unreachable (ECONNREFUSED) → network_error",
    probe: () => probeCodexLane("sk-proj-x", failFetch()),
    code: "network_error",
    reset_at: null,
  },
  {
    name: "OpenAI 400 → unknown",
    probe: () => probeCodexLane("sk-proj-x", respondWith(400, openAiError("invalid_request_error", "garbage"))),
    code: "unknown",
    reset_at: null,
  },
];

for (const c of errorCodeCases) {
  test(`error code: ${c.name}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const result = await c.probe();
    assert.equal(result.error_code, c.code);
    assert.equal(result.reset_at, c.reset_at);
  });
}

test("error code: every ErrorCode value is produced by at least one real-error case", () => {
  const covered = new Set(errorCodeCases.map((c) => c.code));
  assert.deepEqual([...covered].sort(), [...ERROR_CODES].sort());
});

test("error code: Codex usage limit with no retry-after takes reset_at from its 'try again at' text", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const result = await probeCodexLane("sk-proj-x", respondWith(429, openAiError("usage_limit_reached", CODEX_USAGE_LIMIT)));
  assert.equal(result.error_code, "quota_exceeded");
  // Codex renders the time in the CLI host's local zone, so the expectation is
  // built the same way and holds under any TZ.
  assert.equal(result.reset_at, new Date(2026, 9, 13, 20, 25).toISOString());
});

// ---------------------------------------------------------------------------
// Codex "try again at" reset text (PANT-841). Formats come from
// codex-rs/protocol/src/error.rs format_retry_timestamp: local time, no zone,
// date omitted when the reset is later the same local day.
// ---------------------------------------------------------------------------

const tryAgainCases: Array<{ name: string; message: string; reset_at: string | null }> = [
  { name: "dated form", message: CODEX_USAGE_LIMIT, reset_at: new Date(2026, 9, 13, 20, 25).toISOString() },
  {
    name: "capitalised 'Try again at' with a curly apostrophe (Enterprise/unknown plan copy)",
    message: "You’ve hit your usage limit. Try again at Nov 1st, 2026 9:05 AM.",
    reset_at: new Date(2026, 10, 1, 9, 5).toISOString(),
  },
  { name: "12 AM is midnight", message: "try again at Dec 2nd, 2026 12:00 AM.", reset_at: new Date(2026, 11, 2, 0, 0).toISOString() },
  { name: "12 PM is noon", message: "try again at Dec 3rd, 2026 12:30 PM.", reset_at: new Date(2026, 11, 3, 12, 30).toISOString() },
  {
    name: "same-day form carries only the time",
    message: "You've hit your usage limit. or try again at 11:59 PM.",
    reset_at: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 23, 59).toISOString(),
  },
  { name: "impossible date", message: "try again at Feb 30th, 2026 8:25 PM.", reset_at: null },
  { name: "unknown month", message: "try again at Foo 3rd, 2026 8:25 PM.", reset_at: null },
  { name: "'try again later' has no time", message: "You've hit your usage limit. Try again later.", reset_at: null },
  { name: "unrelated text", message: "rate limited", reset_at: null },
];

for (const c of tryAgainCases) {
  test(`try again at: ${c.name}`, () => {
    assert.equal(parseTryAgainAtResetTime(c.message, NOW), c.reset_at);
  });
}

test("error code: Codex usage limit prefers retry-after over the 'try again at' text", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const result = await probeCodexLane(
    "sk-proj-x",
    respondWith(429, openAiError("usage_limit_reached", CODEX_USAGE_LIMIT), { "retry-after": "60" }),
  );
  assert.equal(result.error_code, "quota_exceeded");
  assert.equal(result.reset_at, "2026-09-27T12:01:00.000Z");
});
