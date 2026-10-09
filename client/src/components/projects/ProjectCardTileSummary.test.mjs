import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["client/src/components/projects/ProjectCardTileSummary.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  jsx: "automatic", alias: { "@": resolve("client/src") }, logLevel: "silent",
});
const bundled = new Module(`${process.cwd()}/tile-summary-isolated.cjs`);
bundled.filename = `${process.cwd()}/tile-summary-isolated.cjs`;
bundled.paths = Module._nodeModulePaths(process.cwd());
bundled._compile(bundle.outputFiles[0].text, bundled.filename);
const Summary = bundled.exports.default;
const render = (card, children, hasUnreadMention = false) => new JSDOM(renderToStaticMarkup(React.createElement(Summary, { card, hasUnreadMention }, children))).window.document;

test("completed tile matches the reference: check, range, description and real relationship counts", () => {
  const doc = render({
    title: "BNMS Invited Speakers certificate",
    is_complete: true, start_date: "2026-10-06", due_date: "2026-10-08",
    description: "Leave off session title and send certificates",
    project_card_comment: [{ count: 3 }], project_card_attachment: [{ id: "a" }, { id: "b" }, { id: "c" }],
  });
  assert.ok(doc.querySelector('[aria-label="Completed"]'));
  const date = doc.querySelector('[data-testid="tile-date-badge"]');
  assert.equal(date.textContent, "6 Oct – 8 Oct");
  assert.ok(date.classList.contains("bg-[#5a7f23]"));
  assert.ok(date.classList.contains("text-white"));
  assert.ok(doc.querySelector('[aria-label="Has description"]'));
  assert.equal(doc.querySelector('[aria-label="3 comments"]').textContent, "3");
  assert.equal(doc.querySelector('[aria-label="3 attachments"]').textContent, "3");
  assert.equal(date.className.includes("bg-red"), false, "completed dates never look overdue");
});

test("single dates, missing/invalid dates and zero counts do not leave misleading badges", () => {
  const start = render({ title: "Start only", start_date: "2026-10-06" });
  assert.equal(start.querySelector('[data-testid="tile-date-badge"]').textContent, "6 Oct");
  assert.match(start.querySelector('[data-testid="tile-date-badge"]').getAttribute("aria-label"), /^Starts/);
  const due = render({ title: "Due only", due_date: "2026-10-08" });
  assert.equal(due.querySelector('[data-testid="tile-date-badge"]').textContent, "8 Oct");
  for (const card of [
    { title: "Minimal" },
    { title: "Empty metadata", start_date: "bad", due_date: "invalid", description: "  ", project_card_comment: [{ count: 0 }], project_card_attachment: [] },
  ]) {
    const doc = render(card);
    assert.equal(doc.querySelector('[role="img"]'), null);
    assert.equal(doc.body.textContent, card.title);
  }
});

test("incomplete overdue date remains red; today and future dates stay neutral", () => {
  const past = render({ title: "Late", due_date: "2001-01-02" });
  assert.ok(past.querySelector('[data-testid="tile-date-badge"]').classList.contains("bg-[#c62828]"));
  assert.ok(past.querySelector('[data-testid="tile-date-badge"]').classList.contains("text-white"));
  assert.match(past.querySelector('[data-testid="tile-date-badge"]').getAttribute("aria-label"), /Overdue/);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  for (const due_date of [today, "2099-01-02"]) {
    const doc = render({ title: "On time", due_date });
    assert.equal(doc.querySelector('[data-testid="tile-date-badge"]').className.includes("bg-[#c62828]"), false);
  }
});

test("completion takes precedence over an overdue date; unread bell is independent and non-interactive", () => {
  const doc = render({ title: "Finished late", is_complete: true, due_date: "2001-01-02" }, null, true);
  const badge = doc.querySelector('[data-testid="tile-date-badge"]');
  assert.ok(badge.classList.contains("bg-[#5a7f23]"));
  assert.ok(badge.classList.contains("text-white"));
  assert.doesNotMatch(badge.getAttribute("aria-label"), /Overdue/);
  assert.ok(doc.querySelector('[aria-label="Unread mentions"] svg'));
  assert.equal(doc.querySelector("button, a"), null);
  assert.ok(render({ title: "Mention only" }, null, true).querySelector('[data-testid="tile-mention-badge"]'));
  assert.equal(render({ title: "Read" }).querySelector('[data-testid="tile-mention-badge"]'), null);
});

test("singular counts and priority remain accessible; summary never captures the card click", () => {
  const doc = render({
    title: "VeryLongUnbrokenTitle".repeat(20), description: "Notes", project_card_comment: [{ count: "1" }],
    project_card_attachment: [{ id: "one" }],
  }, React.createElement("span", null, "urgent"));
  assert.ok(doc.querySelector('[aria-label="1 comment"]'));
  assert.ok(doc.querySelector('[aria-label="1 attachment"]'));
  assert.ok(doc.body.textContent.includes("urgent"));
  assert.ok(doc.querySelector('[class*="overflow-wrap:anywhere"]'));
  assert.equal(doc.querySelector("button, a"), null);
});

test("persisted timestamp dates use written calendar days instead of shifting across time zones", () => {
  const doc = render({ title: "Local date", start_date: "2026-10-06T00:00:00Z", due_date: "2026-10-08T23:00:00-11:00" });
  assert.equal(doc.querySelector('[data-testid="tile-date-badge"]').textContent, "6 Oct – 8 Oct");
});
