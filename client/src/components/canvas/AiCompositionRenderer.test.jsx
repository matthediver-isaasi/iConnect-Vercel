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
