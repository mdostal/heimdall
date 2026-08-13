import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGeminiPublicStatus } from "./gemini.js";

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
    }) as Response) as typeof fetch;
}

test("no incidents at all resolves to up", async () => {
  const signal = await checkGeminiPublicStatus(fakeFetch([]));
  assert.equal(signal.status, "up");
  assert.equal(signal.reason, null);
});

test("an open incident naming a Gemini/Vertex AI product resolves to degraded by default", async () => {
  const signal = await checkGeminiPublicStatus(
    fakeFetch([
      {
        external_desc: "Vertex AI Gemini API customers experienced increased error rates",
        severity: "medium",
        status_impact: "SERVICE_DISRUPTION",
        affected_products: [{ title: "Vertex AI Gemini API" }],
      },
    ]),
  );
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /Vertex AI Gemini API/);
});

test("an open incident with outage-level impact resolves to down", async () => {
  const signal = await checkGeminiPublicStatus(
    fakeFetch([
      {
        external_desc: "Generative AI on Vertex AI is fully down",
        severity: "high",
        status_impact: "SERVICE_OUTAGE",
        affected_products: [{ title: "Generative AI on Vertex AI" }],
      },
    ]),
  );
  assert.equal(signal.status, "down");
});

test("an already-ended incident is not treated as currently affecting status", async () => {
  const signal = await checkGeminiPublicStatus(
    fakeFetch([
      {
        end: "2026-02-27T06:45:00Z",
        severity: "high",
        status_impact: "SERVICE_OUTAGE",
        affected_products: [{ title: "Vertex AI Gemini API" }],
      },
    ]),
  );
  assert.equal(signal.status, "up");
});

test("an open incident affecting unrelated GCP products (VMware, Bare Metal) does not flag this lane", async () => {
  const signal = await checkGeminiPublicStatus(
    fakeFetch([
      {
        external_desc: "GCVE/BMS/NetApp Volumes power failure",
        severity: "high",
        status_impact: "SERVICE_OUTAGE",
        affected_products: [{ title: "VMware Engine" }, { title: "Bare Metal Solution" }],
      },
    ]),
  );
  assert.equal(signal.status, "up");
});

test("a non-200 status feed response degrades gracefully, doesn't throw", async () => {
  const signal = await checkGeminiPublicStatus(fakeFetch({}, false, 500));
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /500/);
});

test("a network failure degrades gracefully, doesn't throw", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const signal = await checkGeminiPublicStatus(fetchImpl);
  assert.equal(signal.status, "degraded");
  assert.match(signal.reason ?? "", /ECONNREFUSED/);
});

test("a malformed (non-array) feed shape degrades gracefully, never reports up", async () => {
  const signal = await checkGeminiPublicStatus(fakeFetch({ unexpected: "shape" }));
  assert.equal(signal.status, "degraded");
});

test("consumes no per-lane API tokens — only calls the public feed, no credential involved", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = (async (url: unknown) => {
    callCount += 1;
    assert.equal(url, "https://status.cloud.google.com/incidents.json");
    return { ok: true, status: 200, json: async () => [] } as Response;
  }) as typeof fetch;
  await checkGeminiPublicStatus(fetchImpl);
  assert.equal(callCount, 1);
});
