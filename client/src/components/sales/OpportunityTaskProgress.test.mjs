import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import React, { act } from "react";
import { JSDOM } from "jsdom";

test("opportunity task progress is independently paginated and renders access, completion, and zero-task states", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/sales/dashboard" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const result = await build({
    entryPoints: ["client/src/components/sales/OpportunityTaskProgress.jsx"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    jsx: "automatic",
    alias: { "@": `${process.cwd()}/client/src` },
  });
  const mod = new Module(`${process.cwd()}/opportunity-task-progress-fixture.cjs`);
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(result.outputFiles[0].text, `${process.cwd()}/opportunity-task-progress-fixture.cjs`);
  const { MemoryRouter } = mod.require("react-router-dom");
  const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");
  const requests = [];
  let fail = false;
  globalThis.fetch = async (url, options) => {
    const params = new URL(url, "http://localhost").searchParams;
    requests.push({ params, options });
    const page = Number(params.get("taskProgressPage"));
    const ok = !fail;
    return {
      ok,
      status: ok ? 200 : 503,
      json: async () => ok ? {
        items: page === 1 ? [
          { id: "opp/one", name: "Northstar renewal", status: "available", totalTasks: 4, openTasks: 2, overdueTasks: 1, completedTasks: 2, completionPercent: 50, latestCompletion: { at: "2026-01-02T03:04:00Z", actorName: "Morgan Lee" } },
          { id: "opp-zero", name: "New campus", status: "available", totalTasks: 0, openTasks: 0, overdueTasks: 0, completedTasks: 0, completionPercent: null, latestCompletion: null },
          { id: "opp-restricted", name: "Private board", status: "restricted", totalTasks: null, openTasks: null, overdueTasks: null, completedTasks: null, completionPercent: null, latestCompletion: null },
          { id: "opp-unavailable", name: "Board paused", status: "unavailable", totalTasks: null, openTasks: null, overdueTasks: null, completedTasks: null, completionPercent: null, latestCompletion: null },
        ] : [],
        total: page === 1 ? 14 : 14,
        page,
        pageSize: 10,
        pages: 2,
        summary: { opportunityCount: 14, availableOpportunities: 12, restrictedOpportunities: 1, unavailableOpportunities: 1, totalTasks: 9, openTasks: 5, overdueTasks: 2, completedTasks: 4, completionPercent: 44.4, partial: true },
      } : { message: "Progress report offline" },
    };
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRoot(document.getElementById("root"));
  const settle = async (action = () => {}) => act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 50)); });
  const button = (label) => [...document.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent.trim() === label);
  try {
    await settle(() => root.render(React.createElement(QueryClientProvider, { client: cache },
      React.createElement(MemoryRouter, null, React.createElement(mod.exports.OpportunityTaskProgress)))));
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].params.toString(), "view=task-progress&taskProgressPage=1&taskProgressPageSize=10");
    assert.equal(requests[0].options.credentials, "include");
    assert.match(document.body.textContent, /Opportunity task progress/);
    assert.match(document.body.textContent, /Weighted completion44\.4%/);
    assert.match(document.body.textContent, /Partial totals: 1 restricted and 1 unavailable opportunities excluded/);
    assert.match(document.body.textContent, /02\/01\/2026 03:04 UTC · Recorded by: Morgan Lee/);
    assert.match(document.body.textContent, /No tasks completed/);
    assert.match(document.body.textContent, /No tasks/);
    assert.match(document.body.textContent, /Restricted board/);
    assert.match(document.body.textContent, /Board unavailable/);
    assert.doesNotMatch(document.body.textContent, /100%/);
    assert.equal([...document.querySelectorAll("a")].find((node) => node.textContent.includes("Northstar renewal")).getAttribute("href"), "/sales/opportunities/opp%2Fone");
    assert.equal([...document.querySelectorAll("a")].find((node) => node.textContent.includes("Private board")).getAttribute("href"), "/sales/opportunities/opp-restricted");
    const restrictedRow = [...document.querySelectorAll("li")].find(node => node.textContent.includes("Private board"));
    assert.doesNotMatch(restrictedRow.textContent, /No tasks completed/);
    await settle(() => button("Next opportunity task progress page").click());
    await settle();
    assert.equal(requests.at(-1).params.get("taskProgressPage"), "2");
    assert.match(document.body.textContent, /No opportunities to show/);
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    dom.window.close();
  }
});

test("opportunity task progress hides cached figures on errors and retry restores the empty state", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/sales/dashboard" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const result = await build({
    entryPoints: ["client/src/components/sales/OpportunityTaskProgress.jsx"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    jsx: "automatic",
    alias: { "@": `${process.cwd()}/client/src` },
  });
  const mod = new Module(`${process.cwd()}/opportunity-task-progress-error-fixture.cjs`);
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(result.outputFiles[0].text, `${process.cwd()}/opportunity-task-progress-error-fixture.cjs`);
  const { MemoryRouter } = mod.require("react-router-dom");
  const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");
  let fail = true;
  let release;
  const pending = new Promise(resolve => { release=resolve; });
  globalThis.fetch = async () => {
    await pending;
    return ({
    ok: !fail,
    status: fail ? 503 : 200,
    json: async () => fail ? { error: "Progress report offline" } : {
      items: [], total: 0, page: 1, pageSize: 10, pages: 1,
      summary: { opportunityCount: 0, availableOpportunities: 0, restrictedOpportunities: 0, unavailableOpportunities: 0, totalTasks: 0, openTasks: 0, overdueTasks: 0, completedTasks: 0, completionPercent: null, partial: false },
    },
    });
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRoot(document.getElementById("root"));
  const settle = async (action = () => {}) => act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 50)); });
  try {
    await settle(() => root.render(React.createElement(QueryClientProvider, { client: cache },
      React.createElement(MemoryRouter, null, React.createElement(mod.exports.OpportunityTaskProgress)))));
    assert.ok(document.querySelector('[aria-label="Loading opportunity task progress"]'));
    await settle(() => release());
    await settle();
    assert.match(document.body.textContent, /Progress report offline/);
    assert.doesNotMatch(document.body.textContent, /Weighted completion|Opportunities/);
    fail = false;
    await settle(() => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Retry").click());
    await settle();
    assert.doesNotMatch(document.body.textContent, /Progress report offline/);
    assert.match(document.body.textContent, /No opportunities to show/);
    fail = true;
    await settle(() => { void cache.invalidateQueries({queryKey:["sales-reports","task-progress"]}); });
    await settle();
    assert.match(document.body.textContent,/Progress report offline/);
    assert.doesNotMatch(document.body.textContent,/Weighted completion|No opportunities to show/);
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    dom.window.close();
  }
});
