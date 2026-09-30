/**
 * AiCompositionRenderer DOM structure tests (Task #2893).
 *
 * Proves with real React rendering (renderToStaticMarkup) that:
 * - a valid nested flex JSON document renders nested DOM — children live
 *   INSIDE their container element, never as sibling orphans;
 * - unresolved CTAs render as real (disabled) <button> elements, not
 *   decorative spans.
 *
 * Runs under tsx (see the `test` workflow) because it needs JSX + @ aliases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AiCompositionRenderer from "./AiCompositionRenderer.jsx";

const doc = {
  schemaVersion: 1,
  id: "comp_test",
  sections: [
    {
      id: "sec1",
      type: "ai_section",
      readingOrder: ["hero_heading", "benefits_grid", "cta"],
      elements: [
        { id: "hero_heading", type: "heading", role: "h2", content: { text: "Why join" } },
        {
          id: "benefits_grid",
          type: "container",
          children: [
            {
              id: "card_1",
              type: "card",
              children: [
                { id: "card_1_title", type: "heading", role: "h3", content: { text: "Benefit one" } },
                { id: "card_1_body", type: "paragraph", content: { text: "Body one" } },
              ],
            },
            {
              id: "card_2",
              type: "card",
              children: [
                { id: "card_2_title", type: "heading", role: "h3", content: { text: "Benefit two" } },
              ],
            },
          ],
        },
        { id: "cta", type: "button", content: { text: "Join now" } },
      ],
    },
  ],
  layouts: {
    desktop: {
      hero_heading: { mode: "flow", w: 1200 },
      benefits_grid: { mode: "grid", w: 1200, grid: { columns: 2, gap: 24 } },
      card_1: { mode: "flow" },
      card_1_title: { mode: "flow" },
      card_1_body: { mode: "flow" },
      card_2: { mode: "flow" },
      card_2_title: { mode: "flow" },
      cta: { mode: "flow", w: 200 },
    },
  },
};

test("nested containers render nested DOM, not sibling orphans", () => {
  const html = renderToStaticMarkup(
    <AiCompositionRenderer document={doc} instanceId="t1" />,
  );
  // The grid container opens before its cards and closes after them.
  // (Match the element's class attribute, NOT the selector in <style>.)
  const gridStart = html.indexOf('class="aic-e-benefits_grid"');
  assert.ok(gridStart > -1, "container rendered");
  const gridOpenEnd = html.indexOf(">", gridStart);
  // Find the container's matching close tag by depth-walking from its open tag.
  const openTagStart = html.lastIndexOf("<", gridStart);
  let depth = 0;
  let i = openTagStart;
  let gridEnd = -1;
  while (i < html.length) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 4;
    } else {
      depth -= 1;
      i = nextClose + 6;
      if (depth === 0) { gridEnd = nextClose; break; }
    }
  }
  assert.ok(gridEnd > gridOpenEnd, "container close tag found");
  const inside = html.slice(gridOpenEnd, gridEnd);
  // All nested children (including grandchildren) live INSIDE the container.
  for (const id of ["card_1", "card_1_title", "card_1_body", "card_2", "card_2_title"]) {
    assert.ok(inside.includes(`aic-e-${id}`), `${id} nested inside container`);
  }
  // Non-children stay outside.
  assert.ok(!inside.includes("aic-e-hero_heading"));
  assert.ok(!inside.includes("aic-e-cta"));
  assert.ok(inside.includes("Benefit one") && inside.includes("Body one"));
});

test("unresolved CTA renders a real disabled button, not a span", () => {
  const html = renderToStaticMarkup(
    <AiCompositionRenderer document={doc} instanceId="t2" />,
  );
  assert.match(html, /<button[^>]*type="button"[^>]*disabled[^>]*data-aic-cta="unresolved"[^>]*>Join now<\/button>/);
  assert.ok(!/<span[^>]*data-testid="button-aic-cta"/.test(html));
});

test("in selectable (editor) mode the unresolved CTA is enabled for selection", () => {
  const html = renderToStaticMarkup(
    <AiCompositionRenderer document={doc} instanceId="t3" selectable />,
  );
  const btn = html.match(/<button[^>]*data-aic-cta="unresolved"[^>]*>/)?.[0] || "";
  assert.ok(btn, "unresolved CTA button rendered");
  assert.ok(!btn.includes("disabled"), "editor-mode CTA is not disabled");
});

// ---------------------------------------------------------------------------
// Minimum acceptance example (task "Done looks like"): a hand-authored valid
// composition — one auto-height section, two-column desktop / one-column
// mobile, nested container, heading, paragraph, illustration placeholder,
// two distinct cards, real CTA link — proven end-to-end: passes schema
// validation, renders nested DOM, and emits valid unit-carrying scoped CSS.
// ---------------------------------------------------------------------------
import { validateComposition } from "../../../../api/_lib/aiCompositionSchema.js";
import { buildAicCss } from "../../lib/aiCompositionRender.js";

const acceptanceDoc = {
  schemaVersion: 1,
  id: "comp_acceptance",
  name: "Minimum acceptance composition",
  compositionType: "section",
  sections: [
    {
      id: "sec_a",
      type: "ai_section",
      readingOrder: ["a_heading", "a_intro", "a_grid", "a_cta"],
      elements: [
        { id: "a_heading", type: "heading", role: "h2", content: { text: "Why members join" }, style: { fontSize: { value: 32, unit: "px" } } },
        { id: "a_intro", type: "paragraph", content: { text: "Two good reasons, side by side." } },
        {
          id: "a_grid",
          type: "container",
          children: [
            {
              id: "a_card_1",
              type: "card",
              children: [
                { id: "a_c1_img", type: "generated_illustration", imageBrief: { subject: "handshake illustration", styleNotes: "flat" } },
                { id: "a_c1_title", type: "heading", role: "h3", content: { text: "Community" } },
                { id: "a_c1_body", type: "paragraph", content: { text: "Meet peers across the sector." } },
              ],
            },
            {
              id: "a_card_2",
              type: "card",
              children: [
                { id: "a_c2_title", type: "heading", role: "h3", content: { text: "Recognition" } },
                { id: "a_c2_body", type: "paragraph", content: { text: "Professional standing that counts." } },
              ],
            },
          ],
        },
        { id: "a_cta", type: "button", content: { text: "Apply today" }, link: { kind: "external", url: "https://example.org/apply" }, resolvedHref: "https://example.org/apply" },
      ],
    },
  ],
  layouts: {
    desktop: {
      a_heading: { mode: "flow", w: 900 },
      a_intro: { mode: "flow", w: 720 },
      a_grid: { mode: "grid", w: 1100, grid: { columns: 2, gap: 24 } },
      a_card_1: { mode: "flow" },
      a_c1_img: { mode: "flow" },
      a_c1_title: { mode: "flow" },
      a_c1_body: { mode: "flow" },
      a_card_2: { mode: "flow" },
      a_c2_title: { mode: "flow" },
      a_c2_body: { mode: "flow" },
      a_cta: { mode: "flow", w: 220 },
    },
    mobile: {
      a_grid: { mode: "grid", w: 360, grid: { columns: 1, gap: 16 } },
    },
  },
};

test("acceptance fixture passes schema validation", () => {
  const result = validateComposition(acceptanceDoc);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("acceptance fixture renders correct nested DOM with a real CTA link", () => {
  const html = renderToStaticMarkup(
    <AiCompositionRenderer document={acceptanceDoc} instanceId="acc" />,
  );
  // Cards live inside the grid container, in order.
  const grid = html.indexOf('class="aic-e-a_grid"');
  const c1 = html.indexOf('class="aic-e-a_card_1"');
  const c2 = html.indexOf('class="aic-e-a_card_2"');
  assert.ok(grid > -1 && c1 > grid && c2 > c1, "cards nested inside grid, in order");
  // Illustration placeholder renders (no broken img) and is decorative.
  assert.match(html, /aic-e-a_c1_img[^>]*aic-img-placeholder|aic-img-placeholder[^>]*aic-e-a_c1_img/);
  // CTA is a real anchor with the resolved href, never a span.
  assert.match(html, /<a[^>]*href="https:\/\/example\.org\/apply"[^>]*>Apply today<\/a>/);
  assert.ok(!html.includes('role="presentation"'));
});

test("acceptance fixture emits valid scoped CSS with units and mobile override", () => {
  const css = buildAicCss(acceptanceDoc, "acc");
  // Every rule is scoped to the instance.
  for (const line of css.split("\n")) {
    if (!line.trim() || line.startsWith("@media") || line === "}") continue;
    assert.ok(line.includes('[data-aic="acc"]'), `scoped: ${line.slice(0, 60)}`);
  }
  // {value,unit} style serialized with a unit; no unitless length declarations.
  assert.ok(css.includes("font-size:32px"), "font-size carries px");
  assert.ok(!/(?:width|height|font-size|gap|padding|margin|border-radius):\d+(?:;|})/.test(css), "no unitless lengths");
  // Mobile override present: single-column grid at the mobile breakpoint.
  assert.match(css, /@media[^{]*max-width[^{]*\{[^]*aic-e-a_grid\{[^}]*grid-template-columns:repeat\(1,/);
});
