// Real service entrypoint (hdl-05) — composes everything built across the
// lane-health-status and hdl-scheduler epics into one running Heimdall:
// lane registry + state store + Argus telemetry + per-lane
// MulticaAutopilotScheduler (coarse, default) + InProcessScheduler (fine,
// suspect-lane-only) + the actuation stub wired to a lightweight shared
// status-change observer + the HTTP server (now with the real
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
import { ActuationStub } from "./core/scheduler/actuation-stub.js";
import type { CommandRunner } from "./core/scheduler/command-runner.js";

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
}

export interface ComposedService {
  httpServer: Server;
  store: StateStore;
  pipelines: Map<string, LanePipeline>;
  multicaSchedulers: MulticaAutopilotScheduler[];
  inProcessSchedulers: InProcessScheduler[];
  actuationStub: ActuationStub;
  stopAll: () => void;
}

export function composeService(options: ComposeServiceOptions = {}): ComposedService {
  const port = options.port ?? Number(process.env.PORT ?? 4870);
  const env = options.env ?? process.env;
  const argus = options.argus ?? new ArgusClient();
  const actuationStub = new ActuationStub();

  const registry = buildLaneRegistry(env);
  const store = new StateStore(env.HEIMDALL_DB_PATH ?? ":memory:");

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
  }

  // Lightweight shared observer feeding the actuation stub — one timer for
  // the whole service (not per-lane), cheap local StateStore reads only.
  const statusWatcher = setInterval(() => {
    for (const lane of registry.list()) {
      const current = store.getCurrentStatus(lane.lane_id);
      if (current) actuationStub.onStatusChange(lane, current.status);
    }
  }, STATUS_WATCHER_INTERVAL_MS);
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
    actuationStub,
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
  startArgusSdk();
  composeService();
}
