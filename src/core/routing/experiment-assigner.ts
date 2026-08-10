import type { PolicyExperiments } from "./policy-loader.js";

export function assignExperimentArm(taskId: string, experiment: PolicyExperiments): string {
  const arms = Object.entries(experiment.arms);
  if (arms.length === 0) {
    throw new Error("Cannot assign experiment arm: experiment has no arms");
  }

  const bucket = fnv1a(taskId) % 100;
  let cumulative = 0;
  for (const [armName, arm] of arms) {
    cumulative += arm.split * 100;
    if (bucket < cumulative) return armName;
  }
  return arms[0][0];
}

function fnv1a(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
