import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://calendar.test/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLInputElement", "HTMLSelectElement", "CustomEvent", "KeyboardEvent", "DocumentFragment", "MutationObserver", "NodeFilter", "getComputedStyle", "DOMRect"]) {
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

const creationProps = {
  boardId: "membership-events",
  canEdit: true,
  lists: [{ id: "planning", name: "Planning" }, { id: "review", name: "Review" }],
  onCreateCard: async () => {},
};
async function context(node, clientX = 0) {
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY: 40, button: 2 }));
  });
}
async function chooseAdd() {
  const item = document.querySelector('[role="menuitem"]');
  assert.ok(item, "Add card context item");
  await act(async () => item.click());
}
async function setField(selector, value) {
  const input = document.querySelector(selector);
  assert.ok(input, selector);
  await act(async () => {
    const prototype = input.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
async function submitDialog() {
  await act(async () => document.querySelector('[role="dialog"] form').dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
}

test("month and week blank bodies resolve the pointer column, including adjacent-month days", async () => {
  for (const initialMode of ["month", "week"]) {
    const host = await mount({ ...creationProps, initialMode, initialDate: "2026-10-01" });
    const week = host.querySelector(".calendar-week");
    week.getBoundingClientRect = () => ({ left: 100, width: 700, right: 800, top: 0, bottom: 200, height: 200 });
    // Blank spanning-grid area belongs to Tuesday, not the selected Thursday.
    await context(week.querySelector(".calendar-spans"), 255);
    await chooseAdd();
    assert.equal(document.querySelector("#calendar-card-due").value, "2026-09-29");
    assert.equal(document.querySelector("#calendar-card-list").value, "");
    await act(async () => document.querySelector('[role="dialog"] button[type="button"]').click());
    assert.equal(document.querySelector('[role="dialog"]'), null);
  }
});

test("heading context, day agenda and keyboard/touch Add card use the selected local day", async () => {
  const host = await mount(creationProps);
  await context(host.querySelector('[data-calendar-day="2026-10-14"]'));
  await chooseAdd();
  assert.equal(document.querySelector("#calendar-card-due").value, "2026-10-14");
  await act(async () => document.querySelector('[role="dialog"] button[type="button"]').click());
  await click(host, ".calendar-create button");
  assert.equal(document.querySelector("#calendar-card-due").value, "2026-10-14");
  await act(async () => document.querySelector('[role="dialog"] button[type="button"]').click());
  await click(host, '[aria-label="View Friday, 9 October 2026"]');
  await context(host.querySelector(".calendar-agenda"));
  await chooseAdd();
  assert.equal(document.querySelector("#calendar-card-due").value, "2026-10-09");
});

test("existing cards never open day creation, and viewers have no creation controls", async () => {
  const host = await mount({ ...creationProps, initialMode: "week" });
  await context(host.querySelector('[data-testid="calendar-card-range"]'), 500);
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  const viewer = await mount({ ...creationProps, canEdit: false, initialMode: "day" });
  assert.equal(viewer.querySelector(".calendar-create"), null);
  await context(viewer.querySelector(".calendar-agenda"));
  assert.equal(document.querySelector('[role="menu"]'), null);
});

test("no lists explains disabled creation without silently selecting a target", async () => {
  const host = await mount({ ...creationProps, lists: [] });
  assert.equal(host.querySelector(".calendar-create button").disabled, true);
  assert.match(host.querySelector(".calendar-create").textContent, /Create a list/);
  await context(host.querySelector('[data-calendar-day="2026-10-08"]'));
  assert.equal(document.querySelector('[role="menuitem"]').getAttribute("aria-disabled"), "true");
  assert.match(document.querySelector('[role="menu"]').textContent, /Create a list/);
});

test("creation requires title and list, preserves errors, retries edited dates and blocks pending dismissal/duplicates", async () => {
  const payloads = [];
  let resolveSave;
  const host = await mount({ ...creationProps, onCreateCard: async payload => {
    payloads.push(payload);
    if (payloads.length === 1) throw new Error("Connection interrupted");
    await new Promise(resolve => { resolveSave = resolve; });
  } });
  await click(host, ".calendar-create button");
  await submitDialog();
  assert.equal(payloads.length, 0);
  await setField("#calendar-card-title", "  Confirm venue access  ");
  await submitDialog();
  assert.equal(payloads.length, 0);
  await setField("#calendar-card-list", "review");
  await setField("#calendar-card-due", "2026-10-12");
  await submitDialog();
  assert.match(document.querySelector('[role="alert"]').textContent, /Connection interrupted/);
  assert.equal(document.querySelector("#calendar-card-title").value, "  Confirm venue access  ");
  assert.equal(document.querySelector("#calendar-card-list").value, "review");
  assert.deepEqual(payloads[0], { boardId: "membership-events", list_id: "review", title: "Confirm venue access", due_date: "2026-10-12" });
  await setField("#calendar-card-due", "2026-10-13");
  await submitDialog();
  await submitDialog();
  assert.equal(payloads.length, 2);
  assert.equal(document.querySelector("#calendar-card-title").disabled, true);
  assert.equal(document.querySelector('[role="dialog"] button[type="button"]').disabled, true);
  await act(async () => document.querySelector('[role="dialog"]').dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.ok(document.querySelector('[role="dialog"]'));
  await act(async () => resolveSave());
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await click(host, ".calendar-create button");
  assert.equal(document.querySelector("#calendar-card-title").value, "");
  assert.equal(document.querySelector("#calendar-card-list").value, "");
  assert.equal(document.querySelector("#calendar-card-due").value, "2026-10-08");
});

test("board changes reset drafts and late saves do not dismiss another board's dialog", async () => {
  let resolveSave;
  const host = await mount({ ...creationProps, onCreateCard: async () => new Promise(resolve => { resolveSave = resolve; }) });
  await click(host, ".calendar-create button");
  await setField("#calendar-card-title", "Old board task");
  await setField("#calendar-card-list", "planning");
  await submitDialog();
  const { root } = mounts.find(item => item.host === host);
  await act(async () => root.render(h(Calendar, { ...creationProps, boardId: "another-board", onOpenCard: () => {}, initialDate: "2026-10-08" })));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await click(host, ".calendar-create button");
  assert.equal(document.querySelector("#calendar-card-title").value, "");
  await act(async () => resolveSave());
  assert.ok(document.querySelector('[role="dialog"]'));
});

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
