import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { parseRouteRequest } from "./route-request.js";
import { 
  validateRoutingPolicy, 
  getLastKnownGoodPolicy, 
  resetLastKnownGoodPolicyForTesting 
} from "./routing-policy.js";

describe("Routing Policy & Request Validation", () => {
  beforeEach(() => {
    resetLastKnownGoodPolicyForTesting();
  });

  test("Valid policy config with lane capabilities/cost/headroom returns a usable RoutingPolicy object", () => {
    const validConfig = {
      version: "1.0",
      lanes: {
        "lane-1": {
          capabilities: ["text", "code"],
          cost_weight: 1.0,
          trust_tier: "standard",
          headroom_limits: {
            max_concurrent_requests: 10,
            max_tokens_per_minute: 50000,
          }
        }
      },
      degraded_fallback: [],
      heuristic_variants: [],
      experiments: []
    };

    const result = validateRoutingPolicy(validConfig);
    
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.policy);
    assert.equal(result.policy?.version, "1.0");
    assert.equal(result.policy?.lanes["lane-1"].cost_weight, 1.0);
    assert.equal(result.policy?.lanes["lane-1"].headroom_limits?.max_concurrent_requests, 10);
  });

  test("Cheap-tier allowed policy for bulk task class is valid (no hardcoded ban)", () => {
    const cheapTierAllowedConfig = {
      version: "1.0",
      lanes: {
        "cheap-lane": {
          capabilities: ["bulk_processing"],
          cost_weight: 0.1,
          trust_tier: "cheap"
        }
      },
      allowed_task_tiers: {
        "bulk": ["cheap", "standard"]
      }
    };

    const result = validateRoutingPolicy(cheapTierAllowedConfig);
    
    assert.equal(result.valid, true);
    assert.ok(result.policy);
    assert.deepEqual(result.policy?.allowed_task_tiers?.["bulk"], ["cheap", "standard"]);
    assert.equal(result.policy?.lanes["cheap-lane"].trust_tier, "cheap");
  });

  test("Malformed policy config returns actionable errors and does not replace last known-good policy", () => {
    const validConfig = {
      version: "1.0",
      lanes: {
        "lane-1": {
          capabilities: ["text"],
          cost_weight: 1.0,
          trust_tier: "standard"
        }
      }
    };

    // First set a known good policy
    validateRoutingPolicy(validConfig);
    assert.ok(getLastKnownGoodPolicy());
    assert.equal(getLastKnownGoodPolicy()?.version, "1.0");

    const malformedConfig = {
      version: "2.0",
      lanes: {
        "bad-lane": {
          // missing capabilities array
          cost_weight: "not-a-number", // invalid type
          trust_tier: "untrusted" // invalid tier
        }
      }
    };

    const result = validateRoutingPolicy(malformedConfig);
    
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 3);
    assert.ok(result.errors.some(e => e.includes("missing capabilities array")));
    assert.ok(result.errors.some(e => e.includes("invalid cost_weight")));
    assert.ok(result.errors.some(e => e.includes("invalid trust_tier")));
    
    // The policy returned in the result should be the last known good one
    assert.ok(result.policy);
    assert.equal(result.policy?.version, "1.0");
    
    // And global state shouldn't be affected
    assert.equal(getLastKnownGoodPolicy()?.version, "1.0");
  });

  test("Valid route request is parsed, stripping raw prompt content or credentials", () => {
    const rawRequest = {
      task_type: "bulk",
      estimated_cost: 0.05,
      capabilities: ["text", "code"],
      constraints: ["low-latency"],
      experiment_subject: "user-123",
      // sensitive/raw data that should be stripped
      prompt_content: "Write me a python script...",
      user_credentials: "bearer-token-123",
      system_instructions: "You are a helpful assistant"
    };

    const req = parseRouteRequest(rawRequest);
    
    assert.equal(req.task_type, "bulk");
    assert.equal(req.estimated_cost, 0.05);
    assert.deepEqual(req.capabilities, ["text", "code"]);
    assert.deepEqual(req.constraints, ["low-latency"]);
    assert.equal(req.experiment_subject, "user-123");
    
    // Make sure sensitive data is not present
    assert.equal((req as any).prompt_content, undefined);
    assert.equal((req as any).user_credentials, undefined);
    assert.equal((req as any).system_instructions, undefined);
  });

  test("Malformed route request falls back to safe defaults", () => {
    const rawRequest = {
      task_type: "unknown-type", // invalid type
      capabilities: "not-an-array", // invalid type
      constraints: [123] // invalid array element type
    };

    const req = parseRouteRequest(rawRequest);
    
    assert.equal(req.task_type, "interactive"); // fallback
    assert.deepEqual(req.capabilities, []); // fallback
    assert.deepEqual(req.constraints, []); // fallback, filtered out non-strings
  });
});
