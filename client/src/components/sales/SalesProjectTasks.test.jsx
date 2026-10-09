import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { projectTaskRequest, projectTasksSearch, refreshSalesProjects } from "./useSalesProjectTasks.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { TaskSummary, TaskPagination, TaskError } = await import("./SalesProjectTaskStates.jsx");
after(() => dom.window.close());

test("task filters encode exact project lists and dates, without absent options", () => {
  const params = new URLSearchParams(projectTasksSearch({ view: "tasks", source: "project", scope: "all", listName: "In progress & review", overdue: true, dueFrom: "2026-10-09", dueTo: "", opportunityId: undefined, page: 2, pageSize: 25 }));
  assert.equal(params.get("listName"), "In progress & review");
  assert.equal(params.get("overdue"), "true");
  assert.equal(params.get("page"), "2");
  assert.equal(params.has("opportunityId"), false);
  assert.equal(params.has("dueTo"), false);
});

test("real request uses authenticated same-origin URL and surfaces optimistic conflict status", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: false, status: 409, json: async () => ({ message: "Opportunity version changed" }) };
  };
  try {
    await assert.rejects(projectTaskRequest("/api/sales/project-tasks", { method: "POST", body: JSON.stringify({ action: "mode", taskMode: "project", expectedVersion: 7, opportunityId: "opportunity" }) }), (error) => error.status === 409 && error.message === "Opportunity version changed");
    assert.equal(calls[0].url, "/api/sales/project-tasks");
    assert.equal(calls[0].options.credentials, "include");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.expectedVersion, 7);
    assert.equal(body.action, "mode");
    assert.equal(Object.hasOwn(body, "migrate"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("refresh touches Sales detail version, board metadata, card detail and task sources", async () => {
  let predicate;
  await refreshSalesProjects({ invalidateQueries: async (options) => { predicate = options.predicate; } });
  for (const key of ["sales-project-tasks", "opportunity", "opportunities", "project-board", "project-boards", "card-detail"]) assert.equal(predicate({ queryKey: [key] }), true, key);
  assert.equal(predicate({ queryKey: ["unrelated-screen"] }), false);
});

async function mounted(element, callback) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    await callback(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test("summary renders all four authoritative project counters", async () => {
  await mounted(<TaskSummary summary={{ total: 13, outstanding: 8, completed: 5, overdue: 2 }} />, (container) => {
    assert.deepEqual([...container.querySelectorAll("dt")].map((item) => item.textContent), ["Total tasks", "Outstanding", "Completed", "Overdue"]);
    assert.deepEqual([...container.querySelectorAll("dd")].map((item) => item.textContent), ["13", "8", "5", "2"]);
    assert.match(container.querySelectorAll("dd")[3].className, /text-destructive/);
  });
});

test("pagination disables boundaries and advances to the next real page", async () => {
  const requested = [];
  await mounted(<TaskPagination page={1} total={27} pageSize={25} onPage={(page) => requested.push(page)} />, async (container) => {
    const buttons = container.querySelectorAll("button");
    assert.equal(buttons[0].disabled, true);
    assert.equal(buttons[1].disabled, false);
    await act(async () => buttons[1].click());
    assert.deepEqual(requested, [2]);
  });
  await mounted(<TaskPagination page={2} total={27} pageSize={25} onPage={() => {}} />, (container) => {
    assert.equal(container.querySelectorAll("button")[1].disabled, true);
  });
});

test("error is readable and retry is wired", async () => {
  let retries = 0;
  await mounted(<TaskError error={new Error("Board no longer available")} onRetry={() => { retries += 1; }} />, async (container) => {
    assert.equal(container.querySelector('[role="alert"]').textContent, "Board no longer available");
    await act(async () => container.querySelector("button").click());
    assert.equal(retries, 1);
  });
});
