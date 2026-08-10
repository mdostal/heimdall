export interface ArgusMetric {
  name: string;
  value: number;
  unit?: string;
  timestamp?: string;
  labels?: Record<string, string>;
}

export interface ArgusStats {
  metrics: ArgusMetric[];
  query?: string;
  source?: string;
}

export interface ArgusQueryStatsOptions {
  query?: string;
}

export interface ArgusClientOptions {
  baseUrl?: string;
  statsPath?: string;
  fetch?: typeof fetch;
}

export class ArgusUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArgusUnavailableError";
  }
}

const DEFAULT_ARGUS_STATS_BASE_URL = "http://100.75.161.82:4328";
const DEFAULT_STATS_PATH = "/stats";

export class ArgusStatsClient {
  private readonly baseUrl: string;
  private readonly statsPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ArgusClientOptions = {}) {
    this.baseUrl =
      options.baseUrl ??
      process.env.ARGUS_STATS_URL ??
      process.env.ARGUS_BASE_URL ??
      DEFAULT_ARGUS_STATS_BASE_URL;
    this.statsPath = options.statsPath ?? process.env.ARGUS_STATS_PATH ?? DEFAULT_STATS_PATH;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async queryStats(options: ArgusQueryStatsOptions = {}): Promise<ArgusStats> {
    const url = this.buildStatsUrl(options.query);
    let response: Response;

    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (err) {
      throw new ArgusUnavailableError("Argus stats endpoint is unavailable", { cause: err });
    }

    if (!response.ok) {
      throw new ArgusUnavailableError(
        `Argus stats endpoint returned HTTP ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new ArgusUnavailableError("Argus stats endpoint returned invalid JSON", {
        cause: err,
      });
    }

    return normalizeArgusStats(body, options.query);
  }

  private buildStatsUrl(query: string | undefined): string {
    const url = new URL(this.statsPath, ensureTrailingSlash(this.baseUrl));
    const normalizedQuery = query?.trim();
    if (normalizedQuery) {
      url.searchParams.set("query", normalizedQuery);
    }
    return url.toString();
  }
}

export function normalizeArgusStats(body: unknown, query?: string): ArgusStats {
  if (!isRecord(body)) {
    throw new ArgusUnavailableError("Argus stats response must be an object");
  }

  const metricsBody = body.metrics;
  if (!Array.isArray(metricsBody)) {
    throw new ArgusUnavailableError("Argus stats response is missing metrics");
  }

  return {
    metrics: metricsBody.map(normalizeMetric),
    query: typeof body.query === "string" ? body.query : query,
    source: typeof body.source === "string" ? body.source : undefined,
  };
}

function normalizeMetric(metric: unknown): ArgusMetric {
  if (!isRecord(metric)) {
    throw new ArgusUnavailableError("Argus metric entries must be objects");
  }

  if (typeof metric.name !== "string" || metric.name.trim() === "") {
    throw new ArgusUnavailableError("Argus metric entry is missing name");
  }

  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
    throw new ArgusUnavailableError("Argus metric entry is missing numeric value");
  }

  const normalized: ArgusMetric = {
    name: metric.name,
    value: metric.value,
  };
  if (typeof metric.unit === "string") normalized.unit = metric.unit;
  if (typeof metric.timestamp === "string") normalized.timestamp = metric.timestamp;

  const labels = normalizeLabels(metric.labels);
  if (labels) normalized.labels = labels;

  return normalized;
}

function normalizeLabels(labels: unknown): Record<string, string> | undefined {
  if (labels === undefined) return undefined;
  if (!isRecord(labels)) {
    throw new ArgusUnavailableError("Argus metric labels must be an object");
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value !== "string") {
      throw new ArgusUnavailableError("Argus metric labels must be strings");
    }
    normalized[key] = value;
  }
  return normalized;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
