import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { dashboardReportParams, formatDashboardDate, parseDashboardDate, validateExpectedCloseRange } from "./dashboardDates.mjs";

test("dashboard calendar dates use DD/MM/YYYY without timezone shifts", () => {
  for (const timezone of ["America/Los_Angeles", "Pacific/Auckland"]) {
    const previous = process.env.TZ;
    process.env.TZ = timezone;
    assert.equal(formatDashboardDate("2026-01-02"), "02/01/2026");
    assert.equal(formatDashboardDate("2026-01-02T00:00:00Z"), "02/01/2026");
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("range validation is strict, inclusive and allows individual bounds", () => {
  assert.equal(parseDashboardDate("29/02/2024"), "2024-02-29");
  for (const value of ["29/02/2025", "31/04/2026", "2/01/2026", "01/13/2026", "2026-01-02", " 02/01/2026", "00/01/2026"]) {
    assert.equal(parseDashboardDate(value), null, value);
  }
  assert.ok(validateExpectedCloseRange("03/01/2026", "02/01/2026").error);
  assert.deepEqual(validateExpectedCloseRange("02/01/2026", "02/01/2026"), { expectedCloseFrom: "2026-01-02", expectedCloseTo: "2026-01-02" });
  assert.deepEqual(validateExpectedCloseRange("", "02/01/2026"), { expectedCloseFrom: "", expectedCloseTo: "2026-01-02" });
  assert.equal(dashboardReportParams({ expectedCloseSort: "desc", expectedCloseFrom: "", expectedCloseTo: "2026-01-02" }).toString(), "view=dashboard&expectedCloseSort=desc&expectedCloseTo=2026-01-02");
});

test("dashboard controls apply ranges, retain applied bounds on sort, clear and recover from empty/error states", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/sales/dashboard" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const result = await build({ entryPoints: ["client/src/components/sales/SalesReportingWorkspace.jsx"], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
    plugins: [{
      name: "quote-naming-fixture",
      setup(builder) {
        builder.onResolve({ filter: /hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: 'export const useQuoteNaming = () => ({ singular: "Training Proposal", plural: "Training Proposals", slug: "training-proposals" });',
        }));
      },
    }],
  });
  const mod = new Module(`${process.cwd()}/sales-dashboard-fixture.cjs`);
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(result.outputFiles[0].text, `${process.cwd()}/sales-dashboard-fixture.cjs`);
  const { MemoryRouter } = mod.require("react-router-dom");
  const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");
  const requests = [];
  let fail = false;
  let emptyActivity = false;
  globalThis.fetch = async (url) => {
    requests.push(new URL(url, "http://localhost").searchParams);
    return { ok: !fail, status: fail ? 503 : 200, json: async () => fail ? { message: "Reporting unavailable" } : {
      summary: { currency: "GBP", pipelineValue: 1234 },
      expectedCloses: requests.length === 1 ? [{ id: "close-1", name: "Training renewal", expectedCloseDate: "2026-01-02" }] : [],
      expectedClosesTotal: requests.length === 1 ? 13 : 0,
      recentActivity: emptyActivity ? [] : [{ id: "activity-1", description: "Proposal sent", quoteId: "quote/19", quoteNumber: "P-19", opportunityName: "Training renewal", organizationName: "Example Organisation", actorName: "Alex Smith", date: "2026-01-01T00:00:00Z" },
        { id: "activity-2", description: "Stage moved: Open → Won", opportunityId: "opp/2", opportunityName: "Renewal", actorName: "Name unavailable", date: "2025-12-31T00:00:00Z" }],
      outstandingQuotes: Array.from({ length: 11 }, (_, i) => ({
        id: `version-${i}`, quoteId: `quote/${18 + i}`, quoteNumber: i === 1 ? null : `P-${18 + i}`,
        opportunityName: i === 1 ? null : "Annual training partnership with a very long opportunity name",
        organisationName: i === 1 ? null : "Example British Organisation with a long customer name",
        status: ["issued", "sent", "accepted"][i % 3],
        netMinor: i === 0 ? 10000 : i === 1 ? null : 0, taxMinor: i === 0 ? 2000 : 0,
        grossMinor: i === 0 ? 12000 : 0, currency: i === 2 ? "EUR" : "GBP",
        date: i === 1 ? null : "2026-01-02T00:00:00Z",
      })),
    } };
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRoot(document.getElementById("root"));
  const settle = async (action = () => {}) => act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 50)); });
  const input = (id, value) => {
    const element = document.getElementById(id);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const click = (text) => [...document.querySelectorAll("button")].find((button) => button.textContent === text).click();
  try {
    await settle(() => root.render(React.createElement(QueryClientProvider, { client: cache }, React.createElement(MemoryRouter, null, React.createElement(mod.exports.SalesDashboard)))));
    await settle();
    assert.match(document.body.textContent, /Showing 1 of 13/);
    assert.match(document.body.textContent, /02\/01\/2026/);
    assert.match(document.body.textContent, /01\/01\/2026/);
    assert.match(document.body.textContent, /Outstanding Training Proposals/);
    assert.match(document.body.textContent, /Training Proposal sent/);
    const activityLink = [...document.querySelectorAll("a")].find(node => node.textContent.includes("Training Proposal sent"));
    assert.equal(activityLink.getAttribute("href"), "/sales/training-proposals/quote%2F19");
    for (const value of ["P-19", "Example Organisation", "Recorded by: Alex Smith", "Training renewal", "01/01/2026"]) assert.ok(activityLink.textContent.includes(value), value);
    const stageLink = [...document.querySelectorAll("a")].find(node => node.textContent.includes("Stage moved"));
    assert.equal(stageLink.getAttribute("href"), "/sales/opportunities/opp%2F2");
    assert.match(stageLink.textContent, /Name unavailable/);
    const quoteLink = [...document.querySelectorAll("a")].find(node => node.textContent.includes("P-18"));
    assert.equal(quoteLink.getAttribute("href"), "/sales/training-proposals/quote%2F18");
    for (const value of ["Example British Organisation", "Opportunity: Annual training", "Issued", "GBP", "100.00 net", "Issued: 02/01/2026"]) assert.ok(quoteLink.textContent.includes(value), value);
    for (const value of ["11 outstanding training proposals", "Showing 8 of 11", "Organisation not recorded", "reference not recorded", "Net unavailable", "EUR", "0.00 net", "Issued date not recorded"]) assert.ok(document.body.textContent.includes(value), value);
    assert.doesNotMatch(document.body.textContent, /\[object Object\]|120\.00|version-1/);
    assert.equal([...document.querySelectorAll("a")].find(node => node.textContent === "View all training proposals").getAttribute("href"), "/sales/training-proposals");
    assert.equal([...document.querySelectorAll("a")].filter(node => node.textContent.includes("Issued:")).length, 7);
    quoteLink.focus();
    assert.equal(document.activeElement, quoteLink);
    assert.ok(document.body.textContent.indexOf("Expected closes") < document.body.textContent.indexOf("Recent activity"));
    const expectedCard = document.getElementById("expected-close-sort").closest("form").parentElement.parentElement;
    assert.match(expectedCard.parentElement.textContent, /Recent activity/);
    assert.equal(document.getElementById("expected-close-from").type, "text");
    await settle(() => input("expected-close-from", "31/02/2026"));
    await settle(() => click("Apply"));
    assert.match(document.body.textContent, /Enter valid dates/);
    assert.equal(requests.length, 1);
    await settle(() => { input("expected-close-from", "02/01/2026"); input("expected-close-to", "09/01/2026"); });
    await settle(() => click("Apply"));
    await settle();
    assert.equal(requests.at(-1).get("expectedCloseFrom"), "2026-01-02");
    assert.equal(requests.at(-1).get("expectedCloseTo"), "2026-01-09");
    assert.match(document.body.textContent, /No expected closes match this range/);
    await settle(() => input("expected-close-from", "04/01/2026"));
    await settle(() => {
      const sort = document.getElementById("expected-close-sort");
      sort.value = "desc";
      sort.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await settle();
    assert.equal(requests.at(-1).get("expectedCloseSort"), "desc");
    assert.equal(requests.at(-1).get("expectedCloseFrom"), "2026-01-02", "sort uses applied, not draft range");
    fail = true;
    await settle(() => click("Clear"));
    await settle();
    assert.equal(requests.at(-1).has("expectedCloseFrom"), false);
    assert.equal(requests.at(-1).has("expectedCloseTo"), false);
    assert.equal(requests.at(-1).get("expectedCloseSort"), "desc");
    assert.match(document.body.textContent, /Reporting unavailable/);
    assert.match(document.body.textContent, /Retry activity/);
    assert.equal(document.getElementById("expected-close-from").value, "");
    fail = false;
    emptyActivity = true;
    await settle(() => click("Retry"));
    await settle();
    assert.doesNotMatch(document.body.textContent, /Reporting unavailable/);
    assert.match(document.body.textContent, /Applied range: Today onwards/);
    assert.match(document.body.textContent, /No sales milestones yet/);
    assert.match(document.body.textContent, /sent training proposals and recorded outcomes/);
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    dom.window.close();
  }
});
