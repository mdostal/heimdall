export type ClaudeCapKind = "rate_limit" | "session_limit" | "weekly_limit" | "oauth_expired";

export interface ClaudeCapSignal {
  kind: ClaudeCapKind;
  reset_at: string;
  reason: string;
}

interface HeaderLike {
  get(name: string): string | null;
}

interface ErrorLike {
  status?: unknown;
  statusCode?: unknown;
  body?: unknown;
  response?: unknown;
  message?: unknown;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESET_MS = 7 * DAY_MS;
// The Claude subscription session window is 5 hours, so a session limit with
// no readable reset time recovers well before the weekly default would say.
const SESSION_RESET_MS = 5 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asHeaderLike(value: unknown): HeaderLike | null {
  return isRecord(value) && typeof value.get === "function" ? (value as unknown as HeaderLike) : null;
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNestedString(body: unknown, path: readonly string[]): string | null {
  let cursor: unknown = body;
  for (const part of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[part];
  }
  return pickString(cursor);
}

function extractMessage(input: unknown): string {
  const parts = [
    getNestedString(input, ["error", "message"]),
    getNestedString(input, ["error", "type"]),
    getNestedString(input, ["message"]),
    getNestedString(input, ["type"]),
  ].filter((part): part is string => part !== null);

  return parts.join(" ").toLowerCase();
}

function extractStatus(input: unknown): number | null {
  if (!isRecord(input)) return null;
  return (
    asStatus(input.status) ??
    asStatus(input.statusCode) ??
    (isRecord(input.response) ? asStatus(input.response.status) : null)
  );
}

function extractBody(input: unknown): unknown {
  if (!isRecord(input)) return input;
  if ("body" in input) return input.body;
  if (isRecord(input.response) && "body" in input.response) return input.response.body;
  return input;
}

function extractHeaders(input: unknown): HeaderLike | null {
  if (!isRecord(input)) return null;
  return (
    asHeaderLike(input.headers) ??
    (isRecord(input.response) ? asHeaderLike(input.response.headers) : null)
  );
}

// hdl-error-taxonomy: exported so every provider adapter can convert a raw
// `retry-after` header (seconds, or occasionally a date string per HTTP
// spec) into an absolute reset_at timestamp the same way, instead of each
// one either reimplementing this or — the confirmed bug this was written to
// fix — passing the raw string straight through unparsed.
export function parseRetryAfter(value: string | null, now: Date): string | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? new Date(now.getTime() + seconds * 1000).toISOString() : null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function parseResetTimestamp(value: string | null): string | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }

  // Numeric strings never reach Date.parse: V8 reads "-5" or "0" as a year
  // (2001, 2000) and would turn garbage into a real-looking past reset.
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

// x-ratelimit-reset is ambiguous across providers: some send an absolute
// epoch (seconds or ms), others a relative number of seconds until reset
// (e.g. "60"). Reading "60" as epoch seconds puts reset_at in 1970, so the
// lane looks recovered immediately. Rule: a numeric value below 1e9 (2001-09-09
// as epoch seconds; no real reset is that old) is relative seconds from `now`;
// anything at or above it goes through the absolute epoch rule above.
const RELATIVE_RESET_THRESHOLD = 1_000_000_000;

function parseRateLimitReset(value: string | null, now: Date): string | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0 && numeric < RELATIVE_RESET_THRESHOLD) {
    return new Date(now.getTime() + numeric * 1000).toISOString();
  }
  return parseResetTimestamp(value);
}

// Anthropic sends one RFC 3339 reset per limit bucket; the lane is only usable
// again once every exhausted bucket has reset, so the latest one wins.
const ANTHROPIC_RESET_HEADERS = [
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-reset",
] as const;

function parseAbsoluteDate(value: string | null): string | null {
  if (!value || Number.isFinite(Number(value))) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

// Collects every reset hint the headers carry (x-ratelimit-reset, retry-after,
// anthropic-ratelimit-*-reset) and returns the latest. Unparseable values are
// skipped, so garbage falls through to the caller's next fallback.
function extractHeaderResetAt(headers: HeaderLike | null, now: Date): string | null {
  if (!headers) return null;
  const candidates = [
    parseRateLimitReset(headers.get("x-ratelimit-reset"), now),
    parseRetryAfter(headers.get("retry-after"), now),
    ...ANTHROPIC_RESET_HEADERS.map((name) => parseAbsoluteDate(headers.get(name))),
  ].filter((candidate): candidate is string => candidate !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) => (Date.parse(candidate) > Date.parse(latest) ? candidate : latest));
}

// Older Claude Code builds printed the 5-hour limit as
// "Claude AI usage limit reached|<epoch seconds>".
function parsePipeEpochReset(message: string): string | null {
  const match = message.match(/limit reached\|(\d{9,13})\b/i);
  return match ? parseResetTimestamp(match[1]) : null;
}

function extractResetAt(input: unknown, headers: HeaderLike | null, now: Date, kind: ClaudeCapKind): string {
  const body = extractBody(input);
  const explicit =
    getNestedString(body, ["reset_at"]) ??
    getNestedString(body, ["resetAt"]) ??
    getNestedString(body, ["error", "reset_at"]) ??
    getNestedString(body, ["error", "resetAt"]) ??
    getNestedString(body, ["error", "reset"]);
  const parsedExplicit = parseResetTimestamp(explicit);
  if (parsedExplicit) return parsedExplicit;

  const headerReset = extractHeaderResetAt(headers, now);
  if (headerReset) return headerReset;

  // CLI error messages (e.g. "resets 7pm (America/Chicago)") carry the reset
  // time as human-readable text rather than a header or structured field —
  // try to extract it before falling back to the generic 7-day default.
  const rawMsg = [
    getNestedString(input, ["message"]),
    getNestedString(body, ["message"]),
  ]
    .filter(Boolean)
    .join(" ");
  const isSession = kind === "session_limit";
  const cliReset = parseCliStyleResetTime(rawMsg, now, isSession ? DAY_MS : DEFAULT_RESET_MS);
  if (cliReset) return cliReset;
  const pipeReset = parsePipeEpochReset(rawMsg);
  if (pipeReset) return pipeReset;

  return new Date(now.getTime() + (isSession ? SESSION_RESET_MS : DEFAULT_RESET_MS)).toISOString();
}

// Parses "resets 7pm (America/Chicago)" or "resets 7:30pm (America/Chicago)"
// from a CLI error message into an absolute ISO-8601 reset timestamp. Returns
// null if the pattern is absent or the timezone is unrecognized — callers fall
// through to DEFAULT_RESET_MS in that case. Exported so tests can cover it
// directly without needing a full probeClaudeSubscriptionLane round-trip.
// `rollover` is how far a reset time that already passed today moves forward:
// a week for the weekly cap, a day for the 5-hour session limit.
export function parseCliStyleResetTime(message: string, now: Date, rollover: number = DEFAULT_RESET_MS): string | null {
  const match = message.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^)]+)\)/i);
  if (!match) return null;
  const [, hourStr, minStr = "00", ampm, tz] = match;
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (ampm.toLowerCase() === "pm" && hour < 12) hour += 12;
  else if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;

  try {
    // Get the current local time components in the target timezone.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(({ type, value }) => [type, value]));
    const nowLocalH = parseInt(parts.hour, 10);
    const nowLocalMin = parseInt(parts.minute, 10);
    if (Number.isNaN(nowLocalH) || Number.isNaN(nowLocalMin)) return null;

    // deltaMinutes = target local time – current local time (same timezone).
    // Adding this to now.getTime() gives the UTC instant when local time will
    // be hour:minute today. A negative delta means the reset already passed
    // today; in that case it moves forward by `rollover`.
    const deltaMinutes = (hour * 60 + minute) - (nowLocalH * 60 + nowLocalMin);
    let targetMs = now.getTime() + deltaMinutes * 60_000;
    if (targetMs <= now.getTime()) {
      targetMs += rollover;
    }
    return new Date(targetMs).toISOString();
  } catch {
    return null;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Parses Codex CLI's usage-limit reset text into an absolute ISO-8601 reset
// timestamp. Codex (codex-rs/protocol/src/error.rs, format_retry_timestamp)
// renders the reset in the LOCAL timezone of the machine running the CLI and
// names no zone, in one of two forms:
//   "try again at Oct 13th, 2026 8:25 PM."  (reset on a later local day)
//   "try again at 8:25 PM."                 (reset later the same local day)
// So the text is read in this process's local timezone, which is correct when
// Heimdall runs on the same host as the CLI. Returns null if the pattern is
// absent or names an impossible date.
export function parseTryAgainAtResetTime(message: string, now: Date): string | null {
  const match = message.match(
    /try again at\s+(?:([a-z]{3})\w*\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+)?(\d{1,2}):(\d{2})\s*([ap]m)/i,
  );
  if (!match) return null;
  const [, monStr, dayStr, yearStr, hourStr, minStr, ampm] = match;
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (ampm.toLowerCase() === "pm" && hour < 12) hour += 12;
  else if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;

  let year = now.getFullYear();
  let month = now.getMonth();
  let day = now.getDate();
  if (monStr) {
    month = MONTHS.indexOf(monStr.toLowerCase());
    if (month === -1) return null;
    year = parseInt(yearStr, 10);
    day = parseInt(dayStr, 10);
  }
  const reset = new Date(year, month, day, hour, minute);
  // Reject rollovers such as "Feb 30th".
  if (reset.getMonth() !== month || reset.getDate() !== day) return null;
  return reset.toISOString();
}

function classify(status: number | null, message: string): ClaudeCapKind | null {
  if (message.includes("oauth") && (message.includes("expired") || message.includes("invalid"))) {
    return "oauth_expired";
  }
  if (message.includes("weekly") && (message.includes("limit") || message.includes("cap"))) {
    return "weekly_limit";
  }
  // Claude Code 2.1.x prints "You've hit your session limit · resets 3pm (tz)"
  // (the binary builds it from "You've hit your " + "session limit"); older
  // builds said "5-hour limit" or "Claude AI usage limit reached|<epoch>".
  if (/session limit|5-hour (?:usage )?limit|usage limit reached/.test(message)) {
    return "session_limit";
  }
  if (status === 429) {
    return message.includes("weekly") ? "weekly_limit" : "rate_limit";
  }
  return null;
}

export function parseClaudeCapSignal(input: unknown, now: Date = new Date()): ClaudeCapSignal | null {
  const body = extractBody(input);
  const message = [extractMessage(input), extractMessage(body)].join(" ").trim();
  const status = extractStatus(input) ?? extractStatus(body);
  const kind = classify(status, message);
  if (!kind) return null;

  const reason =
    getNestedString(body, ["error", "message"]) ??
    getNestedString(body, ["message"]) ??
    (kind === "oauth_expired" ? "Claude OAuth token expired" : "Claude API limit reached");

  return {
    kind,
    reset_at: extractResetAt(input, extractHeaders(input), now, kind),
    reason,
  };
}

export function isClaudeCapError(error: unknown): error is ErrorLike {
  return parseClaudeCapSignal(error) !== null;
}
