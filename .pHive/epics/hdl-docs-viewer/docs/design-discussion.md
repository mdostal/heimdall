# Design Discussion — hdl-docs-viewer

## 0. Prelude

Phase 1 of "get this into a standalone app... so we can see and navigate the
docs and work with the diagrams" (operator, 2026-08-16). Researched Portunus's
own real, shipped desktop-app packaging first (`.pHive/epics/hdl-docs-viewer`'s
sibling research, not repeated here) — confirmed Portunus has **no in-app
docs/diagram viewer at all**; its "About" tab is hand-authored static prose,
not a renderer of its actual docs files. This is genuinely new work, not a
port of an existing pattern.

## 1. Approach

Same "no build step, no framework" philosophy the dashboard already holds to
— markdown rendered server-side (`marked`, a real npm dependency — hand-rolling
a parser for docs this rich, with tables/code blocks/links, isn't worth the
risk), Mermaid diagrams rendered client-side against a **locally vendored**
copy of `mermaid.min.js` (served directly from `node_modules` at request time,
no CDN, matching the dashboard's "no external network calls" principle).

`GET /docs` (index) and `GET /docs/:slug` (one rendered page) added to the
same HTTP server the dashboard already runs on — not a separate app or port.
The doc list is a fixed, explicit manifest (`DOC_ENTRIES`) rather than a live
directory scan, so `:slug` validates against a known-safe allowlist instead of
resolving an arbitrary caller-supplied path off disk.

## 2. Packaging forward-compat

`docsRepoRoot` defaults to `process.cwd()` (true for every existing
entrypoint — `npm run dev`/`cli`/`mcp` already assume this for `.env`
loading) but is overridable via `HEIMDALL_REPO_ROOT` — the desktop-app wrapper
(phase 2) will set this explicitly once `docs/` is bundled alongside the
compiled sidecar, rather than assuming the git checkout is still present on
the installed machine.

## 3. Verified live

Real browser check (Playwright) against `/docs/architecture` — the actual
Mermaid flowchart renders correctly, nav highlights the active page, markdown
formatting (headers/bold/lists/code) renders as expected. Not just curl/HTTP
status checks.

## 4. Scale assessment

Small-medium — one new file (`docs-viewer.ts`), two new HTTP routes, one new
static-asset route, two new npm dependencies (`marked`, `mermaid`).
