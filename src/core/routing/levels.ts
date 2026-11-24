// heimdall#142 slice 3: levels (premium / standard / economy) and the
// premium floor for code work.
//
// Lanes and models bind to a level through configuration only: the routing
// policy's `levels` section (by model id, then by lane id) and the `tier` a
// lane declares on its own models (HEIMDALL_LANE_<N>_MODELS
// `model_id=premium`, or `models[].tier` in HEIMDALL_LANES_JSON). Heimdall
// keeps no list of model names here.
//
// Work classes map to the set of levels they may run on. A class the policy
// doesn't list gets premium only: a lower level is opt-in, per class.
//
// The floor is the one thing this module does hard-code, because the ticket
// makes it a rule rather than a setting: build, review, release and code work
// never run below premium. The policy can't loosen it. A floor class whose
// configured levels are anything other than [premium] is an invalid policy,
// and an invalid policy blocks routing (503) exactly as a broken
// excluded_lanes does, rather than routing on a guess.

import type { Lane } from "../lane-registry.js";

export const LEVELS = ["premium", "standard", "economy"] as const;
export type Level = (typeof LEVELS)[number];

/** Work classes that may never run below premium, whatever the policy says. */
export const FLOOR_WORK_CLASSES: readonly string[] = ["build", "review", "release", "code"];

export interface WorkClassPolicy {
  levels: Level[];
  /** True when the class writes code: it is held to the premium floor like build/review/release. */
  code_work: boolean;
}

export interface LevelPolicy {
  /** Model id -> level. */
  models: Record<string, Level>;
  /** Lane id -> level, for a lane whose routed model has no model binding. */
  lanes: Record<string, Level>;
  work_classes: Record<string, WorkClassPolicy>;
}

/** Thrown for an invalid `levels` / `work_classes` section; policy-loader wraps it as PolicyValidationError. */
export class LevelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LevelConfigError";
  }
}

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBindings(value: unknown, field: string): Record<string, Level> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new LevelConfigError(`Invalid field "${field}": expected a map of id to level`);
  const bindings: Record<string, Level> = {};
  for (const [id, level] of Object.entries(value)) {
    if (id.trim() === "") throw new LevelConfigError(`Invalid field "${field}": empty id`);
    if (!isLevel(level)) {
      throw new LevelConfigError(`Invalid field "${field}.${id}": expected one of ${LEVELS.join(", ")}`);
    }
    bindings[id] = level;
  }
  return bindings;
}

function validateWorkClasses(value: unknown): Record<string, WorkClassPolicy> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new LevelConfigError(`Invalid field "work_classes": expected a map of work class to { levels }`);
  const classes: Record<string, WorkClassPolicy> = {};
  for (const [name, raw] of Object.entries(value)) {
    const field = `work_classes.${name}`;
    if (!isRecord(raw)) throw new LevelConfigError(`Invalid field "${field}": expected { levels: [...] }`);
    if (!Array.isArray(raw.levels) || raw.levels.length === 0) {
      throw new LevelConfigError(`Invalid field "${field}.levels": expected a non-empty list of levels`);
    }
    const levels: Level[] = [];
    raw.levels.forEach((level, index) => {
      if (!isLevel(level)) {
        throw new LevelConfigError(`Invalid field "${field}.levels.${index}": expected one of ${LEVELS.join(", ")}`);
      }
      if (!levels.includes(level)) levels.push(level);
    });
    if (raw.code_work !== undefined && typeof raw.code_work !== "boolean") {
      throw new LevelConfigError(`Invalid field "${field}.code_work": expected boolean`);
    }
    const codeWork = raw.code_work === true;
    if ((codeWork || FLOOR_WORK_CLASSES.includes(name)) && (levels.length !== 1 || levels[0] !== "premium")) {
      throw new LevelConfigError(
        `Invalid field "${field}.levels": ${name} is code work and may only run on premium (got ${levels.join(", ")})`,
      );
    }
    classes[name] = { levels, code_work: codeWork };
  }
  return classes;
}

/**
 * Validates the policy's `levels` and `work_classes` sections. Returns null
 * when neither is present: level routing is off and routing behaves exactly
 * as it did before slice 3. `work_classes` without `levels` is an error,
 * because a class that allows levels nothing is bound to can never route.
 */
export function validateLevelPolicy(levels: unknown, workClasses: unknown): LevelPolicy | null {
  const levelsAbsent = levels === undefined || levels === null;
  const classesAbsent = workClasses === undefined || workClasses === null;
  if (levelsAbsent && classesAbsent) return null;
  if (levelsAbsent) throw new LevelConfigError(`Missing required field "levels": work_classes needs level bindings`);
  if (!isRecord(levels)) throw new LevelConfigError(`Invalid field "levels": expected { models, lanes }`);
  for (const key of Object.keys(levels)) {
    if (key !== "models" && key !== "lanes") {
      throw new LevelConfigError(`Invalid field "levels.${key}": expected only "models" and "lanes"`);
    }
  }
  return {
    models: validateBindings(levels.models, "levels.models"),
    lanes: validateBindings(levels.lanes, "levels.lanes"),
    work_classes: validateWorkClasses(workClasses),
  };
}

/**
 * A lane's declared model tiers become level bindings once level routing is
 * on, so each one must name a level. One that doesn't is a config error that
 * blocks routing, rather than a binding quietly ignored.
 */
export function validateLaneTiers(lanes: readonly Lane[]): void {
  for (const lane of lanes) {
    for (const model of lane.models) {
      if (model.tier !== undefined && !isLevel(model.tier)) {
        throw new LevelConfigError(
          `Invalid tier "${model.tier}" on model ${model.id} of lane ${lane.lane_id}: expected one of ${LEVELS.join(", ")}`,
        );
      }
    }
  }
}

export interface AllowedLevels {
  work_class: string;
  levels: Level[];
  /** True when the premium floor applies. */
  floor: boolean;
}

function isFloorClass(policy: LevelPolicy, name: string): boolean {
  return FLOOR_WORK_CLASSES.includes(name) || policy.work_classes[name]?.code_work === true;
}

/**
 * The levels a request may run on. The work class defaults to the task type.
 * When the task type is itself a floor class (build, review), the floor holds
 * even if the caller names a looser work class.
 */
export function allowedLevels(policy: LevelPolicy, taskType: string, workClass?: string): AllowedLevels {
  const name = workClass ?? taskType;
  const floor = isFloorClass(policy, name) || isFloorClass(policy, taskType);
  const configured = policy.work_classes[name]?.levels ?? ["premium"];
  const levels = floor ? configured.filter((level) => level === "premium") : [...configured];
  return { work_class: name, levels: levels.length > 0 ? levels : ["premium"], floor };
}

export type LevelSource = "lane_config" | "policy_model" | "policy_lane";

/**
 * The level of `modelId` when served by `lane`, most specific first: the
 * lane's own tier for that model, the policy's model binding, the policy's
 * lane binding. Null when nothing binds it; an unbound model is never treated
 * as premium.
 */
export function resolveLevel(policy: LevelPolicy, lane: Lane, modelId: string): { level: Level | null; source: LevelSource | null } {
  const laneTier = lane.models.find((model) => model.id === modelId)?.tier;
  if (isLevel(laneTier)) return { level: laneTier, source: "lane_config" };
  const byModel = policy.models[modelId];
  if (byModel) return { level: byModel, source: "policy_model" };
  const byLane = policy.lanes[lane.lane_id];
  if (byLane) return { level: byLane, source: "policy_lane" };
  return { level: null, source: null };
}
