import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SwarmSourceKind = "queue" | "cycle_state" | "router_log" | "agent_log";

export interface SourceRead {
  kind: SwarmSourceKind;
  path: string;
  content: string | null;
  available: boolean;
  error: string | null;
  duration_ms: number;
  read_at: Date;
}

export interface SwarmStateSnapshot {
  created_at: Date;
  queue: SourceRead;
  cycle_states: SourceRead[];
  router_log: SourceRead;
  agent_logs: SourceRead[];
}

export interface IntrospectionContextPaths {
  queue?: string;
  cycleStateDir?: string;
  routerLog?: string;
  agentLogDir?: string;
}

export interface IntrospectionLogger {
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface IntrospectionContextOptions {
  rootDir?: string;
  homeDir?: string;
  paths?: IntrospectionContextPaths;
  logger?: IntrospectionLogger;
  now?: () => Date;
}

type FileSystem = Pick<typeof fs, "readFile" | "readdir">;

interface ResolvedPaths {
  queue: string;
  cycleStateDir: string;
  routerLog: string;
  agentLogDir: string;
}

const noopLogger: IntrospectionLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export class IntrospectionContext {
  private constructor(private readonly state: SwarmStateSnapshot) {}

  static async create(options: IntrospectionContextOptions = {}): Promise<IntrospectionContext> {
    return IntrospectionContext.createWithFileSystem(fs, options);
  }

  static async createWithFileSystem(
    fileSystem: FileSystem,
    options: IntrospectionContextOptions = {},
  ): Promise<IntrospectionContext> {
    const now = options.now ?? (() => new Date());
    const logger = options.logger ?? noopLogger;
    const paths = resolvePaths(options);
    const createdAt = now();
    const readAt = () => new Date(createdAt.getTime());

    const [queue, cycleStates, routerLog, agentLogs] = await Promise.all([
      readTextSource(fileSystem, "queue", paths.queue, logger, readAt),
      readDirectorySources(fileSystem, "cycle_state", paths.cycleStateDir, logger, readAt),
      readTextSource(fileSystem, "router_log", paths.routerLog, logger, readAt),
      readDirectorySources(fileSystem, "agent_log", paths.agentLogDir, logger, readAt),
    ]);

    return new IntrospectionContext(
      deepFreezeSnapshot({
        created_at: createdAt,
        queue,
        cycle_states: cycleStates,
        router_log: routerLog,
        agent_logs: agentLogs,
      }),
    );
  }

  snapshot(): SwarmStateSnapshot {
    return cloneSnapshot(this.state);
  }

  getQueueYaml(): SourceRead {
    return cloneSourceRead(this.state.queue);
  }

  listCycleStates(): SourceRead[] {
    return this.state.cycle_states.map(cloneSourceRead);
  }

  getCycleState(epicId: string): SourceRead | null {
    const expectedBasename = `${epicId}.yaml`;
    const source = this.state.cycle_states.find((item) => path.basename(item.path) === expectedBasename);
    return source ? cloneSourceRead(source) : null;
  }

  getRouterLog(): SourceRead {
    return cloneSourceRead(this.state.router_log);
  }

  listAgentLogs(): SourceRead[] {
    return this.state.agent_logs.map(cloneSourceRead);
  }

  getAgentLog(agentId: string): SourceRead | null {
    const expectedBasename = `${agentId}.log`;
    const source = this.state.agent_logs.find((item) => path.basename(item.path) === expectedBasename);
    return source ? cloneSourceRead(source) : null;
  }
}

function resolvePaths(options: IntrospectionContextOptions): ResolvedPaths {
  const rootDir = options.rootDir ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  return {
    queue: options.paths?.queue ?? path.join(rootDir, ".pHive", "queue.yaml"),
    cycleStateDir: options.paths?.cycleStateDir ?? path.join(rootDir, ".pHive", "cycle-state"),
    routerLog: options.paths?.routerLog ?? path.join(homeDir, ".claude", "hive", "logs", "router.log"),
    agentLogDir: options.paths?.agentLogDir ?? path.join(homeDir, ".claude", "hive", "logs", "agents"),
  };
}

async function readDirectorySources(
  fileSystem: FileSystem,
  kind: "cycle_state" | "agent_log",
  directoryPath: string,
  logger: IntrospectionLogger,
  readAt: () => Date,
): Promise<SourceRead[]> {
  const start = performance.now();
  try {
    const entries = await fileSystem.readdir(directoryPath, { withFileTypes: true });
    const extension = kind === "cycle_state" ? ".yaml" : ".log";
    const filePaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(directoryPath, entry.name))
      .sort();
    const reads = await Promise.all(
      filePaths.map((filePath) => readTextSource(fileSystem, kind, filePath, logger, readAt)),
    );
    logger.info("introspection directory read succeeded", {
      kind,
      path: directoryPath,
      files: reads.length,
      duration_ms: elapsedMs(start),
    });
    return reads;
  } catch (error) {
    logger.warn("introspection directory read failed", {
      kind,
      path: directoryPath,
      error: errorMessage(error),
      duration_ms: elapsedMs(start),
    });
    return [];
  }
}

async function readTextSource(
  fileSystem: FileSystem,
  kind: SwarmSourceKind,
  filePath: string,
  logger: IntrospectionLogger,
  readAt: () => Date,
): Promise<SourceRead> {
  const start = performance.now();
  try {
    const content = await fileSystem.readFile(filePath, "utf8");
    const result = {
      kind,
      path: filePath,
      content,
      available: true,
      error: null,
      duration_ms: elapsedMs(start),
      read_at: readAt(),
    };
    logger.info("introspection source read succeeded", logFields(result));
    return result;
  } catch (error) {
    const result = {
      kind,
      path: filePath,
      content: null,
      available: false,
      error: errorMessage(error),
      duration_ms: elapsedMs(start),
      read_at: readAt(),
    };
    logger.warn("introspection source read failed", logFields(result));
    return result;
  }
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logFields(result: SourceRead): Record<string, unknown> {
  return {
    kind: result.kind,
    path: result.path,
    available: result.available,
    error: result.error,
    duration_ms: result.duration_ms,
  };
}

function deepFreezeSnapshot(snapshot: SwarmStateSnapshot): SwarmStateSnapshot {
  Object.freeze(snapshot.queue);
  Object.freeze(snapshot.router_log);
  for (const source of snapshot.cycle_states) Object.freeze(source);
  for (const source of snapshot.agent_logs) Object.freeze(source);
  Object.freeze(snapshot.cycle_states);
  Object.freeze(snapshot.agent_logs);
  return Object.freeze(snapshot);
}

function cloneSnapshot(snapshot: SwarmStateSnapshot): SwarmStateSnapshot {
  return deepFreezeSnapshot({
    created_at: new Date(snapshot.created_at.getTime()),
    queue: cloneSourceRead(snapshot.queue),
    cycle_states: snapshot.cycle_states.map(cloneSourceRead),
    router_log: cloneSourceRead(snapshot.router_log),
    agent_logs: snapshot.agent_logs.map(cloneSourceRead),
  });
}

function cloneSourceRead(source: SourceRead): SourceRead {
  return Object.freeze({
    ...source,
    read_at: new Date(source.read_at.getTime()),
  });
}
