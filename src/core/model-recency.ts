// Per-provider "default to newest models" heuristic — hdl-mc-03. Pure
// function, no I/O — consumes RawModelEntry[] (hdl-mc-02's fetch layer),
// produces the set of model ids that should default to enabled the first
// time they're seen. Every branch below defaults to the SAFE-OPEN choice
// (include) whenever there's no reliable signal to rank by — the harm of
// over-including a slightly-older model (operator sees one extra option,
// can disable it) is far smaller than silently hiding a model an
// operator's own lane already declares. See
// .pHive/epics/hdl-model-catalog/docs/research-brief.md for the sourced
// per-provider signal confirmation this table is built from.

import type { RawModelEntry } from "./signal-sources/model-list/claude.js";

// "Newest ones" is deliberately a top-N window, not just the single latest
// release — an operator's own explicitly-declared HEIMDALL_LANE_N_MODEL
// should very likely land inside the default-enabled set on first boot.
const RECENCY_WINDOW_SIZE = 5;

function topNByCreatedAt(entries: RawModelEntry[], n: number): Set<string> {
  const sorted = [...entries].sort((a, b) => {
    if (a.createdAt === null && b.createdAt === null) return 0;
    if (a.createdAt === null) return 1; // nulls sort last — least likely to rank as "newest"
    if (b.createdAt === null) return -1;
    return b.createdAt.localeCompare(a.createdAt); // descending — newest first
  });
  return new Set(sorted.slice(0, n).map((entry) => entry.id));
}

// Gemini has no date field at all (research-brief.md, confirmed) — extract
// the leading generation number from the id (e.g. "gemini-3-pro-preview"
// -> 3, "gemini-2.5-pro" -> 2.5) and include every entry at the HIGHEST
// generation found. An id that doesn't match this pattern at all defaults
// to included (safe-open — never silently excluded on a parse miss).
const GEMINI_GENERATION_RE = /^gemini-(\d+(?:\.\d+)?)/;

function geminiDefaults(entries: RawModelEntry[]): Set<string> {
  let maxGeneration = -Infinity;
  const parsed = entries.map((entry) => {
    const match = entry.id.match(GEMINI_GENERATION_RE);
    const generation = match ? Number(match[1]) : null;
    if (generation !== null && generation > maxGeneration) maxGeneration = generation;
    return { id: entry.id, generation };
  });

  const enabled = new Set<string>();
  for (const entry of parsed) {
    // Unparseable id (generation === null) -> safe-open, always included.
    // Parseable id -> included only if it's at the max generation found.
    if (entry.generation === null || entry.generation === maxGeneration) {
      enabled.add(entry.id);
    }
  }
  return enabled;
}

export function defaultEnabledModelIds(provider: string, entries: RawModelEntry[]): Set<string> {
  if (entries.length === 0) return new Set();

  if (provider === "gemini") {
    return geminiDefaults(entries);
  }

  if (provider === "claude" || provider === "codex") {
    return topNByCreatedAt(entries, RECENCY_WINDOW_SIZE);
  }

  if (provider === "kimi") {
    const hasAnySignal = entries.some((entry) => entry.createdAt !== null);
    // No real signal to rank by across the whole list -- enable everything
    // rather than guess a subset (research-brief.md's documented fallback).
    if (!hasAnySignal) return new Set(entries.map((entry) => entry.id));
    return topNByCreatedAt(entries, RECENCY_WINDOW_SIZE);
  }

  // An ungated/unrecognized provider reaching this function is not
  // expected (model-catalog.ts only calls this for the four gated
  // providers) — safe-open rather than silently returning an empty set.
  return new Set(entries.map((entry) => entry.id));
}
