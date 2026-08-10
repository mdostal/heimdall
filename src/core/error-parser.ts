export type ClaudeCapKind = "rate_limit" | "weekly_limit" | "oauth_expired";

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

const DEFAULT_RESET_MS = 7 * 24 * 60 * 60 * 1000;

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

function parseRetryAfter(value: string | null, now: Date): string | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function parseResetTimestamp(value: string | null): string | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function extractResetAt(input: unknown, headers: HeaderLike | null, now: Date): string {
  const body = extractBody(input);
  const explicit =
    getNestedString(body, ["reset_at"]) ??
    getNestedString(body, ["resetAt"]) ??
    getNestedString(body, ["error", "reset_at"]) ??
    getNestedString(body, ["error", "resetAt"]) ??
    getNestedString(body, ["error", "reset"]);
  const parsedExplicit = parseResetTimestamp(explicit);
  if (parsedExplicit) return parsedExplicit;

  const headerReset = parseResetTimestamp(headers?.get("x-ratelimit-reset") ?? null);
  if (headerReset) return headerReset;

  const retryAfter = parseRetryAfter(headers?.get("retry-after") ?? null, now);
  if (retryAfter) return retryAfter;

  return new Date(now.getTime() + DEFAULT_RESET_MS).toISOString();
}

function classify(status: number | null, message: string): ClaudeCapKind | null {
  if (message.includes("oauth") && (message.includes("expired") || message.includes("invalid"))) {
    return "oauth_expired";
  }
  if (message.includes("weekly") && (message.includes("limit") || message.includes("cap"))) {
    return "weekly_limit";
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
    reset_at: extractResetAt(input, extractHeaders(input), now),
    reason,
  };
}

export function isClaudeCapError(error: unknown): error is ErrorLike {
  return parseClaudeCapSignal(error) !== null;
}
