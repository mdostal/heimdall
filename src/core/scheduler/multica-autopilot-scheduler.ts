// MulticaAutopilotScheduler — coarse cron backend, the DEFAULT scheduling
// backend for every lane (hdl-03). Registers a cron-driven Multica autopilot
// pointing at a configured agent (MULTICA_AUTOPILOT_AGENT). Provisioning the
// actual Multica-side agent that gets dispatched is a cross-repo concern —
// Heimdall's scope stops at registering the autopilot correctly.
//
// IMPORTANT (corrected during implementation via direct live-CLI inspection,
// 2026-07-25 — `multica autopilot --help`, `multica autopilot get <id>
// --output json`, `multica autopilot list --output json`): registering a
// schedule is a TWO-STEP model, not the one-shot `trigger-add` originally
// assumed in this story's spec:
//   1. `multica autopilot create --title <t> --mode run_only --agent <a>
//      --description <d> --output json` — creates the autopilot itself
//      (idempotency key is `title`; Multica has no upsert-by-title CLI verb,
//      so THIS class checks `list` by title first, matching the documented
//      "reconciler upserts by title" behavior at the Heimdall integration
//      layer since Multica's CLI doesn't do it automatically).
//   2. `multica autopilot trigger-add <autopilot-id> --kind schedule --cron
//      "<cron>" --output json` — adds the actual cron trigger, keyed off the
//      real server-assigned autopilot ID (a UUID), NOT a Heimdall-chosen slug.
// This class checks for an existing autopilot (by title) and an existing
// schedule trigger (via `get`) before calling create/trigger-add, so start()
// is safe to call on every Heimdall startup without duplicating registrations.
//
// Confirmed live: existing autopilots in this workspace use generic
// assignee agents (e.g. "dostal-dev"), not bespoke ones — ordinary agent
// identifiers work here.

import type { Scheduler } from "./scheduler.js";
import type { CommandRunner } from "./command-runner.js";
import { NodeCommandRunner } from "./command-runner.js";
import type { Lane } from "../lane-registry.js";
import type { ArgusEmitter } from "../telemetry/argus-client.js";

export interface MulticaAutopilotSchedulerOptions {
  lane: Lane;
  /** Standard 5-field cron (minute hour day month weekday) — no seconds field. */
  cron: string;
  /** What the dispatched agent should actually do when this autopilot fires
   * (becomes the autopilot's --description, i.e. its task prompt). Supplied
   * by the wiring layer (hdl-05), which knows the real refresh-trigger
   * command/endpoint — this class doesn't guess at it. */
  description: string;
  /** Defaults to process.env.MULTICA_AUTOPILOT_AGENT. */
  agent?: string;
  commandRunner?: CommandRunner;
  argus: ArgusEmitter;
  onRegistrationError?: (err: unknown, lane: Lane) => void;
}

interface AutopilotSummary {
  id: string;
  title: string;
}

interface AutopilotTrigger {
  kind: string;
  cron?: string;
}

interface AutopilotGetResponse {
  autopilot: AutopilotSummary;
  triggers?: AutopilotTrigger[];
}

interface AutopilotListResponse {
  autopilots: AutopilotSummary[];
}

interface AutopilotCreateResponse {
  autopilot: AutopilotSummary;
}

/**
 * Validates the cron floor: Multica's autopilot cron is standard 5-field
 * (minute hour day month weekday) with no seconds field — 1-minute is
 * already the finest granularity that syntax can express. The one way to
 * accidentally smuggle in sub-minute intent is a 6-field cron with a
 * leading seconds field, which some other cron dialects support but
 * Multica's does not — reject that explicitly, before shelling out.
 */
export function validateCronExpression(cron: string): void {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 6) {
    throw new Error(
      `Cron expression "${cron}" has 6 fields (includes a seconds field). ` +
        "Multica's autopilot cron floor is 1 minute — use standard 5-field cron " +
        "(minute hour day month weekday), no seconds field.",
    );
  }
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields (minute hour day month weekday), got ${fields.length}: "${cron}"`,
    );
  }
}

function slugify(laneId: string): string {
  return laneId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function autopilotTitleFor(laneId: string): string {
  return `heimdall-lane-${slugify(laneId)}`;
}

export class MulticaAutopilotScheduler implements Scheduler {
  private readonly commandRunner: CommandRunner;
  private readonly agent: string | undefined;
  private readonly onRegistrationError: (err: unknown, lane: Lane) => void;

  constructor(private readonly opts: MulticaAutopilotSchedulerOptions) {
    this.commandRunner = opts.commandRunner ?? new NodeCommandRunner();
    this.agent = opts.agent ?? process.env.MULTICA_AUTOPILOT_AGENT;
    this.onRegistrationError =
      opts.onRegistrationError ??
      ((err, lane) =>
        console.error(
          `[multica-autopilot-scheduler] failed to register autopilot for lane ${lane.lane_id}:`,
          err,
        ));
  }

  /**
   * Validates synchronously (throws clearly on bad cron or missing agent —
   * REQ-07's "never crash the whole service, but never silently no-op
   * either" pattern: THIS call throws so the failure is visible; it's the
   * caller/wiring layer's job to catch per-lane and not let one bad lane's
   * config take down startup for every other lane).
   *
   * The actual CLI registration is fire-and-forget from here (network/process
   * calls, can't propagate to a synchronous `start(): void` caller) — call
   * registerNow() directly in tests for deterministic, awaitable assertions.
   */
  start(): void {
    validateCronExpression(this.opts.cron);
    if (!this.agent) {
      throw new Error(
        "MULTICA_AUTOPILOT_AGENT is not configured — cannot register a Multica autopilot without an agent identifier.",
      );
    }
    void this.registerNow();
  }

  stop(): void {
    // Intentional no-op for v1: Multica's own reconciler (upserts by title,
    // never auto-deletes orphans) owns autopilot lifecycle. "stop" here
    // means "Heimdall stops managing this lane's scheduling for this run",
    // not "tear down the cron registration" — deleting it on every service
    // stop would be destructive and isn't what this method is for.
  }

  /** Exposed for direct, awaitable test invocation — see start()'s doc comment. */
  async registerNow(): Promise<void> {
    try {
      const title = autopilotTitleFor(this.opts.lane.lane_id);
      const autopilotId = await this.findOrCreateAutopilot(title);
      await this.ensureScheduleTrigger(autopilotId);

      this.opts.argus.emitTick({
        laneId: this.opts.lane.lane_id,
        provider: this.opts.lane.provider,
        source: "multica_autopilot_scheduler",
      });
    } catch (err) {
      this.onRegistrationError(err, this.opts.lane);
    }
  }

  private async findOrCreateAutopilot(title: string): Promise<string> {
    const { stdout: listOut } = await this.commandRunner.run("multica", [
      "autopilot",
      "list",
      "--output",
      "json",
    ]);
    const listResult = JSON.parse(listOut) as AutopilotListResponse;
    const existing = listResult.autopilots.find((a) => a.title === title);
    if (existing) return existing.id;

    const { stdout: createOut } = await this.commandRunner.run("multica", [
      "autopilot",
      "create",
      "--title",
      title,
      "--mode",
      "run_only",
      "--agent",
      this.agent!,
      "--description",
      this.opts.description,
      "--output",
      "json",
    ]);
    const createResult = JSON.parse(createOut) as AutopilotCreateResponse;
    return createResult.autopilot.id;
  }

  private async ensureScheduleTrigger(autopilotId: string): Promise<void> {
    const { stdout: getOut } = await this.commandRunner.run("multica", [
      "autopilot",
      "get",
      autopilotId,
      "--output",
      "json",
    ]);
    const getResult = JSON.parse(getOut) as AutopilotGetResponse;
    const hasScheduleTrigger = (getResult.triggers ?? []).some((t) => t.kind === "schedule");
    if (hasScheduleTrigger) return;

    await this.commandRunner.run("multica", [
      "autopilot",
      "trigger-add",
      autopilotId,
      "--kind",
      "schedule",
      "--cron",
      this.opts.cron,
      "--output",
      "json",
    ]);
  }
}
