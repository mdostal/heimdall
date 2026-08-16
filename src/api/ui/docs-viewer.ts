// In-app docs + diagram viewer (hdl-docs-viewer) — "see and navigate the docs
// and work with the diagrams" from inside the running service itself, not
// just on GitHub/GitHub Pages. Same "no build step" philosophy as
// dashboard.ts: markdown is rendered server-side (marked), Mermaid diagrams
// are rendered client-side against a locally-vendored copy of mermaid.js
// (served from node_modules at request time — no CDN, no network call, same
// "no external network calls" principle the dashboard already holds to).
//
// The doc list is a fixed, explicit manifest — not a live directory scan —
// so GET /docs/:slug can validate against a known-safe allowlist instead of
// reading an arbitrary caller-supplied path off disk.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { marked, type Tokens } from "marked";

export interface DocEntry {
  slug: string;
  title: string;
  /** Relative to the repo root. */
  path: string;
}

// hdl-docs-viewer: the explicit, known-safe doc manifest. Add a new entry
// here when a new docs/*.md file is meant to be browsable in-app — this is
// the one seam, mirroring routing-strategies/registry.ts's "add a file,
// register it here, touch nothing else" pattern.
export const DOC_ENTRIES: readonly DocEntry[] = [
  { slug: "index", title: "Overview", path: "docs/index.md" },
  { slug: "vision", title: "Vision & Roadmap", path: "docs/vision.md" },
  { slug: "architecture", title: "Architecture", path: "docs/architecture.md" },
  { slug: "north-star", title: "North Star", path: "docs/north-star.md" },
  { slug: "heimdall-role-and-actuation", title: "Role & Actuation", path: "docs/heimdall-role-and-actuation.md" },
  { slug: "scheduler-constraints", title: "Scheduler Constraints", path: "docs/scheduler-constraints.md" },
  { slug: "token-rotation-setup", title: "Token Rotation Setup", path: "docs/ops/token-rotation-setup.md" },
  { slug: "dec-429-corroboration", title: "DEC: 429 Corroboration", path: "docs/decisions/DEC-hdl-429-corroboration.md" },
  { slug: "dec-local-build-verification", title: "DEC: Local Build Verification", path: "docs/decisions/DEC-hdl-local-build-verification.md" },
  { slug: "dec-portunus-deferral", title: "DEC: Portunus Deferral", path: "docs/decisions/DEC-hdl-portunus-deferral.md" },
  { slug: "dec-reason-aware-recovery", title: "DEC: Reason-Aware Recovery", path: "docs/decisions/DEC-hdl-reason-aware-recovery.md" },
  { slug: "dec-role-actuation", title: "DEC: Role & Actuation", path: "docs/decisions/DEC-hdl-role-actuation.md" },
  { slug: "dec-scheduler-backend", title: "DEC: Scheduler Backend", path: "docs/decisions/DEC-hdl-scheduler-backend.md" },
  { slug: "client-checkin-out", title: "Client Check-in/out", path: "docs/decisions/client-checkin-out.md" },
];

function getDocBySlug(slug: string): DocEntry | null {
  return DOC_ENTRIES.find((doc) => doc.slug === slug) ?? null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// hdl-docs-viewer: routes fenced ```mermaid blocks to a <pre class="mermaid">
// element mermaid.js's startOnLoad picks up automatically; every other
// fenced language renders as an ordinary escaped <pre><code> block.
const docRenderer = {
  code({ text, lang }: Tokens.Code): string {
    if (lang === "mermaid") {
      return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
    }
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>`;
  },
};
marked.use({ renderer: docRenderer });

/** Reads and renders one doc's markdown to HTML. Returns null if the file genuinely isn't on disk (never throws). */
export function renderDocMarkdown(doc: DocEntry, repoRoot: string): string | null {
  const fullPath = join(repoRoot, doc.path);
  if (!existsSync(fullPath)) return null;
  const raw = readFileSync(fullPath, "utf8");
  return marked.parse(raw, { async: false }) as string;
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0;
    display: flex;
    min-height: 100vh;
  }
  nav {
    width: 240px;
    flex-shrink: 0;
    padding: 1.5rem 1rem;
    border-right: 1px solid rgba(128, 128, 128, 0.3);
    overflow-y: auto;
  }
  nav h1 { font-size: 1rem; margin: 0 0 1rem; }
  nav a.back { display: block; font-size: 0.8rem; color: #888; margin-bottom: 1rem; text-decoration: none; }
  nav a.back:hover { text-decoration: underline; }
  nav ul { list-style: none; margin: 0; padding: 0; }
  nav li { margin-bottom: 0.35rem; }
  nav a { text-decoration: none; font-size: 0.88rem; }
  nav a:hover { text-decoration: underline; }
  nav a.active { font-weight: 600; }
  main {
    flex: 1;
    padding: 2rem 3rem;
    max-width: 900px;
    line-height: 1.6;
  }
  main h1 { font-size: 1.6rem; }
  main h2 { font-size: 1.25rem; margin-top: 2rem; }
  main h3 { font-size: 1.05rem; }
  main pre {
    background: rgba(128, 128, 128, 0.12);
    padding: 0.9rem 1rem;
    border-radius: 6px;
    overflow-x: auto;
  }
  main pre.mermaid { background: transparent; text-align: center; }
  main code { font-family: ui-monospace, monospace; font-size: 0.85em; }
  main table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  main th, main td { text-align: left; padding: 0.4rem 0.7rem; border-bottom: 1px solid rgba(128, 128, 128, 0.3); font-size: 0.9rem; }
  main blockquote { border-left: 3px solid rgba(128, 128, 128, 0.4); margin: 0 0 1rem; padding: 0.1rem 1rem; color: #888; }
`;

export function renderDocsIndexHtml(): string {
  const items = DOC_ENTRIES.map(
    (doc) => `<li><a href="/docs/${encodeURIComponent(doc.slug)}">${escapeHtml(doc.title)}</a></li>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heimdall — Docs</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<nav>
  <a class="back" href="/">&larr; Dashboard</a>
  <h1>Docs</h1>
  <ul>${items}</ul>
</nav>
<main>
  <h1>Heimdall documentation</h1>
  <p>Pick a page from the left — this is the same content that ships in <code>docs/</code>, rendered locally with diagrams live-rendered, no network call.</p>
</main>
</body>
</html>`;
}

export function renderDocPageHtml(doc: DocEntry, bodyHtml: string): string {
  const navItems = DOC_ENTRIES.map((entry) => {
    const activeClass = entry.slug === doc.slug ? " active" : "";
    return `<li><a class="${activeClass.trim()}" href="/docs/${encodeURIComponent(entry.slug)}">${escapeHtml(entry.title)}</a></li>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heimdall — ${escapeHtml(doc.title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<nav>
  <a class="back" href="/">&larr; Dashboard</a>
  <h1><a href="/docs" style="color:inherit;text-decoration:none;">Docs</a></h1>
  <ul>${navItems}</ul>
</nav>
<main>
${bodyHtml}
</main>
<script src="/vendor/mermaid.min.js"></script>
<script>
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: true, theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
  }
</script>
</body>
</html>`;
}

export { getDocBySlug };
