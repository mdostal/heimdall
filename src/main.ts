// Real service entrypoint — composes everything built across the
// lane-health-status, hdl-scheduler, and hdl-actuation epics into one
// running Heimdall: lane registry + state store + Argus telemetry + per-lane
// MulticaAutopilotScheduler (coarse, default) + InProcessScheduler (fine,
// suspect-lane-only) + a shared status-watcher loop that calls
// ControlAdapter.reconcile() every tick for every lane — StubControlAdapter
// for every lane, unconditionally.
//
// hdl-msh-01: Heimdall no longer actuates Multica directly (heimdall#83 —
// Multica's real API has no working disable lever; see docs/decisions/
// DEC-hdl-multica-disable-contract.md). Heimdall's role is now status-only:
// report lane health (GET /lanes) so a downstream actuator (Pantheon's own
// facade) can build the real lever against Multica's real constraints.
//
// Composition is factored into composeService() specifically so tests can
// inject a mock CommandRunner/fetchImpl and inspect every piece without
// touching a real Argus connection or binding a real port.

import { buildLaneRegistry, createHttpServer, type RefreshLaneFn } from "./api/http-server.js";
import type { Server } from "node:http";
import { StateStore, resolveDefaultDbPath } from "./core/state-store.js";
import type { LaneRegistry } from "./core/lane-registry.js";
import {
  LanePipeline,
  claudeAdapters,
  codexAdapters,
  geminiAdapters,
  kimiAdapters,
  openrouterAdapters,
  ollamaAdapters,
  type ProviderAdapters,
} from "./core/lane-pipeline.js";
import { ArgusClient, startArgusSdk, type ArgusEmitter } from "./core/telemetry/argus-client.js";
import { LocalTelemetryRecorder } from "./core/telemetry/local-recorder.js";
import { CompositeTelemetryEmitter } from "./core/telemetry/composite-emitter.js";
import { MulticaAutopilotScheduler } from "./core/scheduler/multica-autopilot-scheduler.js";
import { InProcessScheduler } from "./core/scheduler/in-process-scheduler.js";
import type { CommandRunner } from "./core/scheduler/command-runner.js";
import { StaticLaneAgentResolver, type LaneAgentResolver } from "./core/actuation/lane-agent-resolver.js";
import { StubControlAdapter, type ControlAdapter } from "./core/actuation/control-adapter.js";
import { RotationController, ProviderScopedLaneRegistry } from "./core/rotation-controller.js";
import { startCapResetRecoveryJob, type RunningBackgroundJob } from "./core/background-jobs.js";

const PROVIDER_ADAPTERS: Record<string, () => ProviderAdapters> = {
  claude: claudeAdapters,
  codex: codexAdapters,
  gemini: geminiAdapters,
  kimi: kimiAdapters,
  openrouter: openrouterAdapters,
  ollama: ollamaAdapters,
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
  /** hdl-rr-04 — keyed by provider, only present for providers with 2+ credentialed lanes (nothing to rotate between otherwise). */
  rotationControllers: Map<string, RotationController>;
  stopAll: () => void;
}

// hdl-rr-04: mirrors PROVIDER_ADAPTERS' "every lane always gets a real
// mechanism, never a silent no-op" precedent from hdl-actuation — but
// rotation only makes sense with 2+ credentialed lanes on the SAME
// provider to rotate between, so a single-lane provider correctly gets
// none rather than a controller with nowhere to rotate to.
function buildRotationControllers(registry: LaneRegistry, store: StateStore): Map<string, RotationController> {
  const credentialedByProvider = new Map<string, number>();
  for (const lane of registry.list()) {
    if (lane.credential === null) continue;
    credentialedByProvider.set(lane.provider, (credentialedByProvider.get(lane.provider) ?? 0) + 1);
  }

  const controllers = new Map<string, RotationController>();
  for (const [provider, count] of credentialedByProvider) {
    if (count < 2) continue;
    controllers.set(provider, new RotationController(new ProviderScopedLaneRegistry(registry, provider), store));
  }
  return controllers;
}

export function composeService(options: ComposeServiceOptions = {}): ComposedService {
  const port = options.port ?? Number(process.env.PORT ?? 4870);
  const env = options.env ?? process.env;

  const registry = buildLaneRegistry(env);
  const store = new StateStore(resolveDefaultDbPath(env));

  // hdl-ot-01: Heimdall's own local record (telemetry_events) is the source
  // of truth; Argus is one downstream consumer of the same facts, composed
  // alongside it — never the only place they exist. Every existing call
  // site below keeps its `argus: ArgusEmitter`-typed parameter unchanged.
  const argus = new CompositeTelemetryEmitter([
    new LocalTelemetryRecorder(store),
    options.argus ?? new ArgusClient(),
  ]);

  // hdl-msh-02 threads this resolver into createHttpServer() to expose the
  // lane->Multica-agent mapping over GET /lanes; it no longer feeds any
  // actuation decision here (hdl-msh-01 — see main.ts's header comment).
  const resolver: LaneAgentResolver = new StaticLaneAgentResolver(env);
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

    controlAdapters.set(lane.lane_id, sharedStubControlAdapter);
  }

  // Lightweight shared observer — one timer for the whole service (not
  // per-lane), cheap local StateStore reads only. reconcile() is called
  // every tick for every lane regardless of whether status changed; every
  // lane's adapter is StubControlAdapter (hdl-msh-01), so this now only
  // records/logs the intended action via ActuationStub, never a real call.
  const statusWatcher = setInterval(() => {
    for (const lane of registry.list()) {
      const current = store.getCurrentStatus(lane.lane_id);
      if (!current) continue;
      const adapter = controlAdapters.get(lane.lane_id);
      if (!adapter) continue;
      const manualOverride = store.getManualOverride(lane.lane_id);
      adapter
        .reconcile(lane, current.status, { reason: current.reason, reset_at: current.reset_at, manualOverride })
        .catch((err) => {
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

  // hdl-rr-04: rotation is a credential-selection concern orthogonal to
  // which lane routing picks — it decides which account backs a given
  // provider's calls, not which provider/lane serves a task. Never wired
  // into the live Claude completion call path yet (documented follow-up,
  // see design-discussion.md §4); this wires the controller + cap-reset
  // background job for the first time on either branch and exposes it for
  // manual inspection/rotation via GET/POST /rotation/:provider.
  const rotationControllers = buildRotationControllers(registry, store);
  const rotationJobs: RunningBackgroundJob[] = [];
  for (const controller of rotationControllers.values()) {
    rotationJobs.push(startCapResetRecoveryJob(controller));
  }

  const httpServer = createHttpServer(registry, store, refreshLane, undefined, options.fetchImpl, rotationControllers, resolver);
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
    rotationControllers,
    stopAll: () => {
      clearInterval(statusWatcher);
      for (const s of multicaSchedulers) s.stop();
      for (const s of inProcessSchedulers) s.stop();
      for (const job of rotationJobs) job.stop();
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
