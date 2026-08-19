import { test } from "node:test";
import assert from "node:assert/strict";
import { DOC_ENTRIES, getDocBySlug, renderDocMarkdown, renderDocsIndexHtml, renderDocPageHtml } from "./docs-viewer.js";

test("DOC_ENTRIES has no duplicate slugs", () => {
  const slugs = DOC_ENTRIES.map((d) => d.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("getDocBySlug returns the matching entry", () => {
  const doc = getDocBySlug("architecture");
  assert.ok(doc);
  assert.equal(doc?.path, "docs/architecture.md");
});

test("getDocBySlug returns null for an unknown slug, never throws", () => {
  assert.equal(getDocBySlug("nonexistent"), null);
});

test("getDocBySlug returns null for a path-traversal attempt, never reads outside the manifest", () => {
  assert.equal(getDocBySlug("../../.env"), null);
  assert.equal(getDocBySlug("..%2f..%2f.env"), null);
});

test("renderDocMarkdown returns null (never throws) when the file genuinely isn't on disk", () => {
  const result = renderDocMarkdown({ slug: "fake", title: "Fake", path: "docs/does-not-exist.md" }, process.cwd());
  assert.equal(result, null);
});

test("renderDocMarkdown converts a real doc's markdown to HTML", () => {
  const doc = getDocBySlug("architecture")!;
  const html = renderDocMarkdown(doc, process.cwd());
  assert.ok(html);
  assert.match(html!, /<h1/);
});

test("renderDocMarkdown routes a ```mermaid fenced block to <pre class=\"mermaid\">, not a plain code block", () => {
  const doc = getDocBySlug("architecture")!;
  const html = renderDocMarkdown(doc, process.cwd());
  assert.match(html!, /<pre class="mermaid">/);
});

test("renderDocsIndexHtml lists every doc as a link", () => {
  const html = renderDocsIndexHtml();
  for (const doc of DOC_ENTRIES) {
    assert.match(html, new RegExp(`href="/docs/${doc.slug}"`));
  }
});

test("renderDocPageHtml includes the mermaid vendor script and highlights the active nav entry", () => {
  const doc = getDocBySlug("vision")!;
  const html = renderDocPageHtml(doc, "<h1>Test</h1>");
  assert.match(html, /\/vendor\/mermaid\.min\.js/);
  assert.match(html, /class="active" href="\/docs\/vision"/);
});
