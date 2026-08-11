import {
  MinervaPlanClient,
  MinervaRequestError,
  MinervaUnavailableError,
  type MinervaPlanStatus,
} from "../../adapters/minerva.js";

export interface PlanCommand {
  text?: string;
  user_id?: string;
}

export interface SlackCommandResponse {
  response_type: "ephemeral" | "in_channel";
  text: string;
}

export interface PlanCommandDeps {
  minerva?: Pick<MinervaPlanClient, "triggerPlan" | "queryPlanStatus">;
}

export type ParsedPlanCommand =
  | { action: "trigger"; idea: string; targetRepo?: string }
  | { action: "status"; runId?: string }
  | { action: "help" };

const MINERVA_UNAVAILABLE_MESSAGE =
  "Minerva planning is unavailable right now. Try again after the planner recovers.";

export async function handlePlanCommand(
  command: PlanCommand,
  deps: PlanCommandDeps = {},
): Promise<SlackCommandResponse> {
  const parsed = parsePlanCommand(command.text);
  if (parsed.action === "help") {
    return { response_type: "ephemeral", text: planHelpText() };
  }

  const minerva = deps.minerva ?? new MinervaPlanClient();

  try {
    if (parsed.action === "trigger") {
      const result = await minerva.triggerPlan({
        idea: parsed.idea,
        targetRepo: parsed.targetRepo,
      });
      return {
        response_type: "in_channel",
        text: `Minerva plan started: \`${result.runId}\``,
      };
    }

    const status = await minerva.queryPlanStatus(parsed.runId);
    return {
      response_type: status.status === "none" ? "ephemeral" : "in_channel",
      text: formatPlanStatus(status),
    };
  } catch (err) {
    if (err instanceof MinervaUnavailableError) {
      return {
        response_type: "ephemeral",
        text: MINERVA_UNAVAILABLE_MESSAGE,
      };
    }
    if (err instanceof MinervaRequestError) {
      return {
        response_type: "ephemeral",
        text: `Minerva could not process that plan command: ${err.message}`,
      };
    }
    throw err;
  }
}

export function parsePlanCommand(text: string | undefined): ParsedPlanCommand {
  const normalized = text?.trim();
  if (!normalized) return { action: "help" };

  const [command, ...rest] = normalized.split(/\s+/);
  const tail = rest.join(" ").trim();

  if (command.toLowerCase() === "status") {
    return { action: "status", runId: tail || undefined };
  }

  if (command.toLowerCase() !== "trigger") {
    return { action: "help" };
  }

  const trigger = parseTriggerTail(tail);
  if (!trigger.idea) return { action: "help" };
  return { action: "trigger", ...trigger };
}

export function formatPlanStatus(status: MinervaPlanStatus): string {
  if (status.status === "none") return "No active Minerva plan runs found.";

  const subject = status.runId ? `Minerva plan \`${status.runId}\`` : "Minerva plan";
  const lines = [`${subject} is ${formatStatus(status.status)}.`];
  const metrics = formatMetrics(status.metrics);
  if (metrics) lines.push(metrics);
  return lines.join("\n");
}

function parseTriggerTail(tail: string): { idea: string; targetRepo?: string } {
  const tokens = tail.split(/\s+/).filter(Boolean);
  let targetRepo: string | undefined;
  const ideaTokens: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--target-repo") {
      targetRepo = tokens[index + 1];
      index++;
      continue;
    }
    if (token.startsWith("--target-repo=")) {
      targetRepo = token.slice("--target-repo=".length);
      continue;
    }
    ideaTokens.push(token);
  }

  return { idea: ideaTokens.join(" ").trim(), targetRepo };
}

function formatStatus(status: Exclude<MinervaPlanStatus["status"], "none">): string {
  return status.replace(/_/g, " ");
}

function formatMetrics(metrics: MinervaPlanStatus["metrics"]): string | undefined {
  if (!metrics) return undefined;
  const parts: string[] = [];
  if (metrics.turns !== undefined) parts.push(`${metrics.turns} turns`);
  if (metrics.escalations !== undefined) parts.push(`${metrics.escalations} escalations`);
  if (metrics.driver) parts.push(`driver ${metrics.driver}`);
  return parts.length ? `Metrics: ${parts.join(", ")}` : undefined;
}

function planHelpText(): string {
  return [
    "Use `/plan trigger <idea>` to start a Minerva plan.",
    "Use `/plan status [run_id]` to check active plan status.",
  ].join("\n");
}
