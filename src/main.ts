// Real service entrypoint — composes everything built across the
// lane-health-status, hdl-scheduler, and hdl-actuation epics into one
// running Heimdall: lane registry + state store + Argus telemetry + per-lane
// MulticaAutopilotScheduler (coarse, default) + InProcessScheduler (fine,
// suspect-lane-only) + a shared status-watcher loop that calls
// ControlAdapter.reconcile() every tick for every lane (hda-04) — real
// MulticaControlAdapter for lanes with a configured agent mapping,
// StubControlAdapter for everything else, including the whole service when
// Multica isn't configured at all — plus the HTTP server (with the real
// POST /lanes/:laneId/refresh trigger MulticaAutopilotScheduler's dispatched
// agent calls).
//
// Composition is factored into composeService() specifically so tests can
// inject a mock CommandRunner/fetchImpl and inspect every piece without
// touching a real Multica daemon, a real Argus connection, or binding a
// real port.

import { buildLaneRegistry, createHttpServer, type RefreshLaneFn } from "./api/http-server.js";
import type { Server } from "node:http";
import { StateStore } from "./core/state-store.js";
import {
  LanePipeline,
  claudeAdapters,
  codexAdapters,
  type ProviderAdapters,
} from "./core/lane-pipeline.js";
import { ArgusClient, startArgusSdk, type ArgusEmitter } from "./core/telemetry/argus-client.js";
import { MulticaAutopilotScheduler } from "./core/scheduler/multica-autopilot-scheduler.js";
import { InProcessScheduler } from "./core/scheduler/in-process-scheduler.js";
import type { CommandRunner } from "./core/scheduler/command-runner.js";
import { MulticaRestClient } from "./core/actuation/multica-rest-client.js";
import { CircuitBreaker } from "./core/actuation/circuit-breaker.js";
import { StaticLaneAgentResolver, type LaneAgentResolver } from "./core/actuation/lane-agent-resolver.js";
import { StubControlAdapter, type ControlAdapter } from "./core/actuation/control-adapter.js";
import { MulticaControlAdapter } from "./core/actuation/multica-control-adapter.js";

const PROVIDER_ADAPTERS: Record<string, () => ProviderAdapters> = {
  claude: claudeAdapters,
  codex: codexAdapters,
};

const DEFAULT_AUTOPILOT_CRON = "*/1 * * * *";
const STATUS_WATCHER_INTERVAL_MS = 5_000;

export interface ComposeServiceOptions {
  port?: number;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  fetchImpl?: typeof fetch;
  argus?: ArgusEmitter;
  /** Test-only: skip actually binding the HTTP server to a port. */
  skipHttpListen?: boolean;
  /** Test-only: override the shared status-watcher's tick interval (default 5000ms). */
  statusWatcherIntervalMs?: number;
}

export interface ComposedService {
  httpServer: Server;
  store: StateStore;
  pipelines: Map<string, LanePipeline>;
  multicaSchedulers: MulticaAutopilotScheduler[];
  inProcessSchedulers: InProcessScheduler[];
  controlAdapters: Map<string, ControlAdapter>;
  stopAll: () => void;
}

/**
 * Builds the shared Multica actuation stack once per service. Construction
 * throws (by design — see multica-rest-client.ts) when MULTICA_BASE_URL,
 * MULTICA_WORKSPACE_ID, or the PAT credential aren't configured; that's
 * caught here so an unconfigured deployment degrades to stub-only actuation
 * for every lane instead of crashing the whole service.
 */
function buildMulticaActuationStack(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch | undefined,
): { restClient: MulticaRestClient; circuitBreaker: CircuitBreaker } | null {
  try {
    const restClient = new MulticaRestClient({ env, fetchImpl });
    return { restClient, circuitBreaker: new CircuitBreaker() };
  } catch (err) {
    console.warn(
      `[main] Multica actuation not configured (${(err as Error).message}) — ` +
        `all lanes will use StubControlAdapter.`,
    );
    return null;
  }
}

export function composeService(options: ComposeServiceOptions = {}): ComposedService {
  const port = options.port ?? Number(process.env.PORT ?? 4870);
  const env = options.env ?? process.env;
  const argus = options.argus ?? new ArgusClient();

  const registry = buildLaneRegistry(env);
  const store = new StateStore(env.HEIMDALL_DB_PATH ?? ":memory:");

  const resolver: LaneAgentResolver = new StaticLaneAgentResolver(env);
  const multicaStack = buildMulticaActuationStack(env, options.fetchImpl);
  const sharedMulticaControlAdapter = multicaStack
    ? new MulticaControlAdapter({
        restClient: multicaStack.restClient,
        circuitBreaker: multicaStack.circuitBreaker,
        resolver,
        argus,
      })
    : null;
  const sharedStubControlAdapter = new StubControlAdapter();
  const controlAdapters = new Map<string, ControlAdapter>();

  const pipelines = new Map<string, LanePipeline>();
  const multicaSchedulers: MulticaAutopilotScheduler[] = [];
  const inProcessSchedulers: InProcessScheduler[] = [];

  for (const lane of registry.list()) {
    store.upsertLane({
      lane_id: lane.lane_id,
      provider: lane.provider,
      credential_ref: lane.credential_ref,
    });

    const buildAdapters = PROVIDER_ADAPTERS[lane.provider];
    if (!buildAdapters) {
      console.error(
        `[main] no ProviderAdapters registered for provider "${lane.provider}" (lane ${lane.lane_id}) — skipping scheduling for this lane.`,
      );
      continue;
    }

    const pipeline = new LanePipeline(
      store,
      { now: () => new Date().toISOString(), lastPassiveResponse: () => null, fetchImpl: options.fetchImpl },
      buildAdapters(),
    );
    pipelines.set(lane.lane_id, pipeline);

    const multicaScheduler = new MulticaAutopilotScheduler({
      lane,
      cron: env.HEIMDALL_AUTOPILOT_CRON ?? DEFAULT_AUTOPILOT_CRON,
      description:
        `Trigger a Heimdall lane refresh by sending: ` +
        `POST http://localhost:${port}/lanes/${encodeURIComponent(lane.lane_id)}/refresh`,
      commandRunner: options.commandRunner,
      argus,
    });
    try {
      multicaScheduler.start();
    } catch (err) {
      // Per-lane failure isolation (REQ-07 precedent): one lane's bad config
      // (e.g. missing MULTICA_AUTOPILOT_AGENT) must not prevent every other
      // lane's scheduling from starting.
      console.error(`[main] failed to start MulticaAutopilotScheduler for lane ${lane.lane_id}:`, err);
    }
    multicaSchedulers.push(multicaScheduler);

    const inProcessScheduler = new InProcessScheduler({ lane, pipeline, store, argus });
    inProcessScheduler.start();
    inProcessSchedulers.push(inProcessScheduler);

    const agentIds = resolver.resolve(lane.lane_id);
    const controlAdapter =
      multicaStack && agentIds.length > 0 ? sharedMulticaControlAdapter! : sharedStubControlAdapter;
    controlAdapters.set(lane.lane_id, controlAdapter);
  }

  // Lightweight shared observer driving actuation reconciliation — one timer
  // for the whole service (not per-lane), cheap local StateStore reads only.
  // reconcile() is called every tick for every lane regardless of whether
  // status changed (retry-for-free semantics — see MulticaControlAdapter).
  const statusWatcher = setInterval(() => {
    for (const lane of registry.list()) {
      const current = store.getCurrentStatus(lane.lane_id);
      if (!current) continue;
      const adapter = controlAdapters.get(lane.lane_id);
      if (!adapter) continue;
      adapter.reconcile(lane, current.status, { reason: current.reason, reset_at: current.reset_at }).catch((err) => {
        console.error(`[main] reconcile() failed for lane ${lane.lane_id}:`, err);
      });
    }
  }, options.statusWatcherIntervalMs ?? STATUS_WATCHER_INTERVAL_MS);
  statusWatcher.unref?.();

  const refreshLane: RefreshLaneFn = async (laneId: string): Promise<void> => {
    const lane = registry.get(laneId);
    const pipeline = pipelines.get(laneId);
    if (!lane || !pipeline) {
      throw new Error(`no pipeline configured for lane ${laneId}`);
    }
    await pipeline.refresh(lane);
  };

  const httpServer = createHttpServer(registry, store, refreshLane);
  if (!options.skipHttpListen) {
    httpServer.listen(port, () => {
      console.log(`heimdall service listening on http://localhost:${port}`);
    });
  }

  return {
    httpServer,
    store,
    pipelines,
    multicaSchedulers,
    inProcessSchedulers,
    controlAdapters,
    stopAll: () => {
      clearInterval(statusWatcher);
      for (const s of multicaSchedulers) s.stop();
      for (const s of inProcessSchedulers) s.stop();
      httpServer.close();
      store.close();
    },
  };
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  // The running process otherwise shows up as a bare "node" in `ps`/`pgrep`,
  // indistinguishable from any other Node process on the host — set the
  // title so operators/monitors can find it by name (e.g. `pgrep heimdall`).
  process.title = "heimdall";
  startArgusSdk();
  composeService();
}
