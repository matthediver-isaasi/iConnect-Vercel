import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://calendar.test/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLInputElement"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/projects/ProjectBoardCalendar.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  jsx: "automatic", loader: { ".css": "empty" }, alias: { "@": resolve("client/src") }, logLevel: "silent",
});
const compiled = new Module(`${process.cwd()}/calendar-isolated.cjs`);
compiled.filename = `${process.cwd()}/calendar-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Calendar = compiled.exports.default;
const mounts = [];
const cards = [
  { id: "range", title: "Speaker certificates", start_date: "2026-10-06", due_date: "2026-10-08", is_complete: true, list_id: "review", project_card_label: [{ label_id: "events" }] },
  { id: "due", title: "Review programme", due_date: "2026-10-08" },
  { id: "start", title: "Prepare welcome pack", start_date: "2026-10-08" },
  { id: "undated", title: "Choose committee date" },
];
const h = React.createElement;
async function mount(props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounts.push({ root, host });
  await act(async () => root.render(h(Calendar, { cards, initialDate: "2026-10-08", onOpenCard: () => {}, ...props })));
  return host;
}
async function click(host, selector) {
  const node = host.querySelector(selector);
  assert.ok(node, selector);
  await act(async () => node.click());
}
async function changeDate(host, value) {
  const input = host.querySelector('input[type="date"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
afterEach(async () => {
  for (const { root, host } of mounts.splice(0)) { await act(async () => root.unmount()); host.remove(); }
});
after(() => dom.window.close());

test("mounted calendar changes modes, dates, and month boundaries", async () => {
  const host = await mount({ initialDate: "2026-01-31" });
  await click(host, '[aria-label="Next month"]');
  assert.equal(host.querySelector('input').value, "2026-02-28");
  assert.equal(host.querySelector('[data-testid="calendar-heading"]').textContent, "February 2026");
  await click(host, '[aria-label="Previous month"]');
  assert.equal(host.querySelector('input').value, "2026-01-28");
  await changeDate(host, "2026-12-31");
  await click(host, '.calendar-modes button:first-child');
  assert.equal(host.querySelector('[aria-pressed="true"]').textContent, "Day");
  await click(host, '[aria-label="Next day"]');
  assert.equal(host.querySelector('input').value, "2027-01-01");
  await click(host, '.calendar-modes button:nth-child(2)');
  assert.equal(host.querySelectorAll('[data-testid="calendar-week"]').length, 1);
  await click(host, '.calendar-modes button:nth-child(3)');
  assert.equal(host.querySelectorAll('[data-testid="calendar-week"]').length, 5);
  await click(host, '.calendar-toolbar button:nth-child(2)');
  const now = new Date();
  assert.equal(host.querySelector('input').value, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
});

test("day agenda includes inclusive end date, single dates and undated tasks; clicks pass original card", async () => {
  const opened = [];
  const host = await mount({ initialMode: "day", onOpenCard: card => opened.push(card) });
  for (const card of cards) assert.ok(host.querySelector(`[data-testid="calendar-card-${card.id}"]`));
  assert.match(host.querySelector('.calendar-undated').textContent, /Undated tasks \(1\)/);
  await click(host, '[data-testid="calendar-card-range"]');
  await click(host, '[data-testid="calendar-card-undated"]');
  assert.equal(opened[0], cards[0]);
  assert.equal(opened[1], cards[3]);
  await click(host, '[aria-label="Next day"]');
  assert.equal(host.querySelector('.calendar-agenda [data-testid="calendar-card-range"]'), null);
  assert.match(host.querySelector('.calendar-agenda').textContent, /Nothing scheduled/);
  assert.ok(host.querySelector('[data-testid="calendar-card-undated"]'));
});

test("week spans are continuous, accessible task buttons with labels, completion and unread cues", async () => {
  const long = { id: "long", title: "Meeting preparation", start_date: "2026-10-01", due_date: "2026-10-14" };
  const host = await mount({ cards: [...cards, long], initialMode: "week",
    unreadCardIds: new Set(["range"]), labels: [{ id: "events", name: "Events", color: "#efa900" }],
    lists: [{ id: "review", name: "Review" }],
  });
  const bar = host.querySelector('[data-testid="calendar-card-long"]');
  assert.equal(bar.tagName, "BUTTON");
  assert.equal(bar.style.gridColumn, "1 / 8");
  assert.equal(bar.dataset.continuesBefore, "true");
  assert.equal(bar.dataset.continuesAfter, "true");
  const completed = host.querySelector('[data-testid="calendar-card-range"]');
  assert.ok(completed.querySelector('[aria-label="Completed"]'));
  assert.ok(completed.querySelector('[aria-label="Unread mentions"]'));
  assert.match(completed.textContent, /Events/);
  assert.match(completed.title, /Review/);
  await click(host, '[aria-label="View Thursday, 8 October 2026"]');
  assert.equal(host.querySelector('[aria-pressed="true"]').textContent, "Day");
});

test("crowded weeks render every task and empty calendars remain composed", async () => {
  const crowded = Array.from({ length: 72 }, (_, index) => ({ id: index, title: `Task ${index}`, due_date: "2026-10-08" }));
  const host = await mount({ cards: crowded, initialMode: "week" });
  assert.equal(host.querySelectorAll('.calendar-task').length, 72);
  const empty = await mount({ cards: [] });
  assert.match(empty.textContent, /No dated tasks/);
  assert.match(empty.textContent, /All tasks have dates/);
});

test("board integration keeps inbox and calendar on the same card detail pathway", () => {
  const source = readFileSync("client/src/pages/ProjectBoard.jsx", "utf8");
  assert.match(source, /ProjectBoardInbox boardId=\{boardId\} onOpenCard=\{openCardDetail\}/);
  assert.match(source, /lists=\{lists\} unreadCardIds=\{unreadCardIds\} onOpenCard=\{openCardDetail\}/);
  assert.match(source, /cardDeepLink\.cancel\(\);[\s\S]*setSelectedCard\(card\);[\s\S]*setShowCardDetail\(true\)/);
});
