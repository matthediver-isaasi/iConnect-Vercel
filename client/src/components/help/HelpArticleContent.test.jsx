import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import HelpArticleContent from "./HelpArticleContent.jsx";

/**
 * Regression coverage for the presentation-only RBAC section gate in
 * HelpArticleContent ({{feature: KEY}} ... {{/feature}}).
 *
 * The parser is hand-rolled with nesting-safe depth tracking, and a bug here
 * would either leak gated guidance (e.g. training-fund steps) to members who
 * can't use those features, or hide content from everyone. These tests render
 * the component to static markup (no DOM needed) and assert on the output.
 */

function render(body, canAccessFeature) {
  return renderToStaticMarkup(
    React.createElement(HelpArticleContent, { body, canAccessFeature }),
  );
}

// A gate whose key is allowed shows its inner content.
test("single gate: allowed feature renders inner content", () => {
  const body = [
    "Intro paragraph.",
    "{{feature: training.funds}}",
    "Gated step for training funds.",
    "{{/feature}}",
    "Outro paragraph.",
  ].join("\n");

  const html = render(body, (key) => key === "training.funds");

  assert.ok(html.includes("Intro paragraph."));
  assert.ok(html.includes("Gated step for training funds."));
  assert.ok(html.includes("Outro paragraph."));
});

// A gate whose key is denied drops its inner content but keeps surrounding text.
test("single gate: denied feature hides inner content only", () => {
  const body = [
    "Intro paragraph.",
    "{{feature: training.funds}}",
    "Gated step for training funds.",
    "{{/feature}}",
    "Outro paragraph.",
  ].join("\n");

  const html = render(body, () => false);

  assert.ok(html.includes("Intro paragraph."));
  assert.ok(!html.includes("Gated step for training funds."));
  assert.ok(html.includes("Outro paragraph."));
});

// Gated headings are dropped cleanly along with the body.
test("denied gate drops gated heading and all", () => {
  const body = [
    "{{feature: training.funds}}",
    "## Training Fund Steps",
    "- Do the thing",
    "{{/feature}}",
    "Always visible.",
  ].join("\n");

  const html = render(body, () => false);

  assert.ok(!html.includes("Training Fund Steps"));
  assert.ok(!html.includes("Do the thing"));
  assert.ok(html.includes("Always visible."));
});

// Nested gates: outer denied hides the inner block even if inner is allowed.
test("nested gates: outer denied hides inner allowed content", () => {
  const body = [
    "{{feature: outer.key}}",
    "Outer content.",
    "{{feature: inner.key}}",
    "Inner content.",
    "{{/feature}}",
    "More outer content.",
    "{{/feature}}",
    "After both.",
  ].join("\n");

  // inner.key is allowed, outer.key is not — outer wins, everything gated drops.
  const html = render(body, (key) => key === "inner.key");

  assert.ok(!html.includes("Outer content."));
  assert.ok(!html.includes("Inner content."));
  assert.ok(!html.includes("More outer content."));
  assert.ok(html.includes("After both."));
});

// Nested gates: outer allowed + inner denied hides only the inner block.
test("nested gates: outer allowed, inner denied hides inner only", () => {
  const body = [
    "{{feature: outer.key}}",
    "Outer content.",
    "{{feature: inner.key}}",
    "Inner content.",
    "{{/feature}}",
    "More outer content.",
    "{{/feature}}",
    "After both.",
  ].join("\n");

  const html = render(body, (key) => key === "outer.key");

  assert.ok(html.includes("Outer content."));
  assert.ok(!html.includes("Inner content."));
  assert.ok(html.includes("More outer content."));
  assert.ok(html.includes("After both."));
});

// Nested gates: both allowed shows everything.
test("nested gates: both allowed shows all content", () => {
  const body = [
    "{{feature: outer.key}}",
    "Outer content.",
    "{{feature: inner.key}}",
    "Inner content.",
    "{{/feature}}",
    "More outer content.",
    "{{/feature}}",
  ].join("\n");

  const html = render(body, () => true);

  assert.ok(html.includes("Outer content."));
  assert.ok(html.includes("Inner content."));
  assert.ok(html.includes("More outer content."));
});

// An unclosed open marker keeps skipping to end-of-article when denied.
test("unclosed marker: denied gate suppresses rest of article", () => {
  const body = [
    "Visible intro.",
    "{{feature: training.funds}}",
    "Gated tail with no close.",
    "Still gated.",
  ].join("\n");

  const html = render(body, () => false);

  assert.ok(html.includes("Visible intro."));
  assert.ok(!html.includes("Gated tail with no close."));
  assert.ok(!html.includes("Still gated."));
});

// An unclosed open marker renders the rest when allowed.
test("unclosed marker: allowed gate renders rest of article", () => {
  const body = [
    "Visible intro.",
    "{{feature: training.funds}}",
    "Gated tail with no close.",
  ].join("\n");

  const html = render(body, () => true);

  assert.ok(html.includes("Visible intro."));
  assert.ok(html.includes("Gated tail with no close."));
});

// A stray close marker without an open marker must not crash or leak text.
test("stray close marker: does not render as literal text", () => {
  const body = ["Some content.", "{{/feature}}", "More content."].join("\n");

  const html = render(body, () => true);

  assert.ok(html.includes("Some content."));
  assert.ok(html.includes("More content."));
  assert.ok(!html.includes("{{/feature}}"));
  assert.ok(!html.includes("{{"));
});

// Feature markers themselves must never leak into the rendered output.
test("markers never render as literal text (allowed and denied)", () => {
  const body = [
    "{{feature: some.key}}",
    "Gated content.",
    "{{/feature}}",
    "Ungated content.",
  ].join("\n");

  const allowedHtml = render(body, () => true);
  const deniedHtml = render(body, () => false);

  for (const html of [allowedHtml, deniedHtml]) {
    assert.ok(!html.includes("{{feature"));
    assert.ok(!html.includes("{{/feature"));
    assert.ok(!html.includes("feature: some.key"));
  }
});

// Default (no canAccessFeature prop) allows every section — editor preview.
test("default access allows every gated section", () => {
  const body = [
    "{{feature: any.key}}",
    "Preview-only gated content.",
    "{{/feature}}",
  ].join("\n");

  const html = renderToStaticMarkup(
    React.createElement(HelpArticleContent, { body }),
  );

  assert.ok(html.includes("Preview-only gated content."));
});
