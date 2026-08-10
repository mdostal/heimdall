import {
  ArgusStatsClient,
  ArgusUnavailableError,
  type ArgusMetric,
  type ArgusStats,
} from "../../adapters/argus.js";

export interface StatsCommand {
  text?: string;
  user_id?: string;
}

export interface SlackCommandResponse {
  response_type: "ephemeral" | "in_channel";
  text: string;
}

export interface StatsCommandDeps {
  argus?: Pick<ArgusStatsClient, "queryStats">;
}

const DEFAULT_EMPTY_MESSAGE = "Argus did not return any matching stats.";
const ARGUS_UNAVAILABLE_MESSAGE =
  "Argus stats are unavailable right now. Try again after observability recovers.";

export async function handleStatsCommand(
  command: StatsCommand,
  deps: StatsCommandDeps = {},
): Promise<SlackCommandResponse> {
  const argus = deps.argus ?? new ArgusStatsClient();
  const query = parseStatsQuery(command.text);

  try {
    const stats = await argus.queryStats(query ? { query } : {});
    return {
      response_type: "in_channel",
      text: formatStats(stats),
    };
  } catch (err) {
    if (err instanceof ArgusUnavailableError) {
      return {
        response_type: "ephemeral",
        text: ARGUS_UNAVAILABLE_MESSAGE,
      };
    }
    throw err;
  }
}

export function parseStatsQuery(text: string | undefined): string | undefined {
  const normalized = text?.trim();
  if (!normalized) return undefined;
  return normalized.replace(/^metric\s+/i, "").trim() || undefined;
}

export function formatStats(stats: ArgusStats): string {
  if (stats.metrics.length === 0) return DEFAULT_EMPTY_MESSAGE;

  const heading = stats.query ? `Argus stats for \`${stats.query}\`` : "Argus stats";
  return [heading, ...stats.metrics.map(formatMetric)].join("\n");
}

function formatMetric(metric: ArgusMetric): string {
  const value = metric.unit ? `${metric.value} ${metric.unit}` : String(metric.value);
  const labels = metric.labels ? formatLabels(metric.labels) : "";
  const timestamp = metric.timestamp ? ` (${metric.timestamp})` : "";
  return `- ${metric.name}: ${value}${labels}${timestamp}`;
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return ` [${entries.map(([key, value]) => `${key}=${value}`).join(", ")}]`;
}
