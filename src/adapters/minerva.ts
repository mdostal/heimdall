import { spawn } from "node:child_process";

export type MinervaRunStatus =
  | "in_progress"
  | "waiting_on_human"
  | "awaiting-consus"
  | "complete"
  | "aborted";

export interface MinervaRunMetrics {
  turns?: number;
  escalations?: number;
  auto_resolutions?: number;
  driver?: string;
  started_at?: string;
  elapsed_ms?: number;
  finalized_at?: string;
}

export interface MinervaPlanTriggerOptions {
  idea: string;
  targetRepo?: string;
}

export interface MinervaPlanTrigger {
  runId: string;
}

export interface MinervaPlanStatus {
  runId?: string;
  status: MinervaRunStatus | "none";
  createdAt?: string;
  metrics?: MinervaRunMetrics | null;
}

export interface MinervaClientOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  invoke?: MinervaInvoker;
}

export interface MinervaEnvelope {
  method: string;
  params?: Record<string, unknown>;
}

export type MinervaInvoker = (envelope: MinervaEnvelope) => Promise<Record<string, unknown>>;

export class MinervaUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MinervaUnavailableError";
  }
}

export class MinervaRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MinervaRequestError";
    this.code = code;
  }
}

const DEFAULT_MINERVA_COMMAND = "minerva";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const ACTIVE_STATUSES = new Set<MinervaRunStatus>([
  "in_progress",
  "waiting_on_human",
  "awaiting-consus",
]);

export class MinervaPlanClient {
  private readonly invoke: MinervaInvoker;

  constructor(options: MinervaClientOptions = {}) {
    this.invoke =
      options.invoke ??
      createSubprocessInvoker({
        command: options.command ?? options.env?.MINERVA_COMMAND ?? DEFAULT_MINERVA_COMMAND,
        args: options.args ?? parseArgs(options.env?.MINERVA_ARGS),
        env: options.env,
        timeoutMs: options.timeoutMs ?? parseTimeout(options.env?.MINERVA_CLIENT_TIMEOUT_MS),
      });
  }

  async triggerPlan(options: MinervaPlanTriggerOptions): Promise<MinervaPlanTrigger> {
    const idea = options.idea.trim();
    if (!idea) {
      throw new MinervaRequestError("VALIDATION_FAILED", "Plan trigger requires an idea.");
    }

    const params: Record<string, unknown> = { idea };
    if (options.targetRepo) params.target_repo = options.targetRepo;

    const result = await this.invoke({ method: "startRun", params });
    const runId = result.run_id;
    if (typeof runId !== "string" || !runId) {
      throw new MinervaUnavailableError("Minerva startRun response did not include run_id");
    }
    return { runId };
  }

  async queryPlanStatus(runId?: string): Promise<MinervaPlanStatus> {
    const normalizedRunId = runId?.trim();
    if (normalizedRunId) {
      const result = await this.invoke({
        method: "getRunStatus",
        params: { run_id: normalizedRunId },
      });
      return normalizeStatusResult(result, normalizedRunId);
    }

    const result = await this.invoke({ method: "listRuns" });
    const runs = normalizeRuns(result.runs);
    const active = runs.find((run) => run.status !== "none" && ACTIVE_STATUSES.has(run.status));
    if (!active) return { status: "none" };
    return active;
  }
}

export function createSubprocessInvoker(options: {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): MinervaInvoker {
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (envelope: MinervaEnvelope) => {
    const raw = await runMinervaProcess({
      command: options.command,
      args,
      env: options.env,
      timeoutMs,
      input: JSON.stringify(envelope),
    });
    return parseMinervaResponse(raw);
  };
}

function runMinervaProcess(options: {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new MinervaUnavailableError("Minerva subprocess timed out"));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new MinervaUnavailableError("Minerva subprocess could not be started", { cause: err }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (stdout.trim()) {
        resolve(stdout);
        return;
      }
      reject(
        new MinervaUnavailableError(
          `Minerva subprocess exited ${code ?? "without a code"}${stderr ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });

    child.stdin.end(options.input);
  });
}

function parseMinervaResponse(raw: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw new MinervaUnavailableError("Minerva returned invalid JSON", { cause: err });
  }

  if (!isRecord(body)) {
    throw new MinervaUnavailableError("Minerva response must be an object");
  }
  if (isRecord(body.error)) {
    const code = typeof body.error.code === "string" ? body.error.code : "UNKNOWN_METHOD";
    const message =
      typeof body.error.message === "string" ? body.error.message : "Minerva request failed";
    throw new MinervaRequestError(code, message);
  }
  if (isRecord(body.result)) return body.result;

  throw new MinervaUnavailableError("Minerva response must include result or error");
}

function normalizeStatusResult(
  result: Record<string, unknown>,
  runId?: string,
): MinervaPlanStatus {
  const status = normalizeStatus(result.status);
  return {
    runId,
    status,
    metrics: normalizeMetrics(result.metrics),
  };
}

function normalizeRuns(value: unknown): MinervaPlanStatus[] {
  if (!Array.isArray(value)) {
    throw new MinervaUnavailableError("Minerva listRuns response is missing runs");
  }
  return value
    .map((run) => {
      if (!isRecord(run)) {
        throw new MinervaUnavailableError("Minerva run entries must be objects");
      }
      const runId = typeof run.run_id === "string" ? run.run_id : undefined;
      if (!runId) {
        throw new MinervaUnavailableError("Minerva run entry is missing run_id");
      }
      return {
        runId,
        status: normalizeStatus(run.status),
        createdAt: typeof run.created_at === "string" ? run.created_at : undefined,
      };
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

function normalizeStatus(value: unknown): MinervaRunStatus {
  if (
    value === "in_progress" ||
    value === "waiting_on_human" ||
    value === "awaiting-consus" ||
    value === "complete" ||
    value === "aborted"
  ) {
    return value;
  }
  throw new MinervaUnavailableError("Minerva status response included an unknown status");
}

function normalizeMetrics(value: unknown): MinervaRunMetrics | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new MinervaUnavailableError("Minerva run metrics must be an object or null");
  }

  const metrics: MinervaRunMetrics = {};
  for (const key of ["turns", "escalations", "auto_resolutions", "elapsed_ms"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) metrics[key] = value[key];
  }
  for (const key of ["driver", "started_at", "finalized_at"] as const) {
    if (typeof value[key] === "string") metrics[key] = value[key];
  }
  return metrics;
}

function parseArgs(raw: string | undefined): string[] {
  return raw?.trim() ? raw.trim().split(/\s+/) : [];
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
