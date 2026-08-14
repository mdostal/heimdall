// hdl-rr-03: extracted from route-selector.ts to break a circular value
// import — policy-loader.ts needs TASK_TYPES, and route-selector.ts now
// imports the scored strategy (which imports policy-loader.ts) transitively
// through registry.ts. TaskType has no real dependency on route-selector.ts;
// it belongs on its own. route-selector.ts re-exports these for every
// existing caller — no other file needs to change its import path.

export const TASK_TYPES = ["planning", "build", "review"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export function parseTaskType(value: string | null): TaskType | null {
  return TASK_TYPES.find((taskType) => taskType === value) ?? null;
}
