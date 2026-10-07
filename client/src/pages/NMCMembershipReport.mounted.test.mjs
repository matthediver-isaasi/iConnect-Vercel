import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { BNMS_TENANT_ID, NMC_REPORT_ENDPOINT, NMC_REPORT_FEATURE } from "../lib/nmcMembershipReport.mjs";

// Match the project's mounted-test approach: bundle the real page and real UI
// in memory, controlling only identity/branding boundary hooks and fetch.
// This does not patch application authentication or contact any real service.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://isolated.example.test/NMCMembershipReport",
});
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "Element", "Node", "DocumentFragment", "MutationObserver", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");

const bundle = await build({
  entryPoints: ["client/src/pages/NMCMembershipReport.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  loader: { ".css": "empty" }, logLevel: "silent", jsx: "automatic",
  plugins: [{
    name: "isolated-report-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^@\/hooks\/useMemberAccess$/ }, () => ({ path: "access", namespace: "report-fixture" }));
      builder.onResolve({ filter: /^@\/contexts\/TenantBrandingContext$/ }, () => ({ path: "branding", namespace: "report-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "report-fixture" }, args => ({
        contents: args.path === "access"
          ? "export function useMemberAccess() { return globalThis.__nmcReportFixture.access; }"
          : "export function useTenantBranding() { return globalThis.__nmcReportFixture.branding; }",
        loader: "js",
      }));
    },
  }],
});
const bundled = new Module(`${process.cwd()}/nmc-report-isolated-test.cjs`);
bundled.filename = `${process.cwd()}/nmc-report-isolated-test.cjs`;
bundled.paths = Module._nodeModulePaths(process.cwd());
bundled._compile(bundle.outputFiles[0].text, bundled.filename);
const Page = bundled.exports.default;
// Use the same CJS package instances as the in-memory bundle; mixing ESM and
// CJS React Query creates two distinct provider contexts.
const { MemoryRouter, Routes, Route } = bundled.require("react-router-dom");
const { QueryClient, QueryClientProvider } = bundled.require("@tanstack/react-query");
const h = React.createElement;

const originalFetch = globalThis.fetch;
const originalCreateUrl = URL.createObjectURL;
const originalRevokeUrl = URL.revokeObjectURL;
const originalClick = dom.window.HTMLAnchorElement.prototype.click;
let downloads = [];
let createdUrls = [];
let revokedUrls = [];
URL.createObjectURL = blob => {
  assert.ok(blob.size > 0);
  const url = `blob:isolated-report-${createdUrls.length}`;
  createdUrls.push(url);
  return url;
};
URL.revokeObjectURL = url => revokedUrls.push(url);
dom.window.HTMLAnchorElement.prototype.click = function () {
  downloads.push({ href: this.href, filename: this.download, attached: document.body.contains(this) });
};
after(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateUrl;
  URL.revokeObjectURL = originalRevokeUrl;
  dom.window.HTMLAnchorElement.prototype.click = originalClick;
  delete globalThis.__nmcReportFixture;
  dom.window.close();
});

const accessFixture = {
  memberInfo: { id: "isolated-member-17", tenant_id: BNMS_TENANT_ID },
  sessionValidated: true, isAccessReady: true, isAdmin: true,
  isFeatureExcluded: () => false,
};
const report = {
  reportDate: "2026-03-31",
  sheets: [
    { name: "Print active", count: 37 }, { name: "Print grace", count: 4 },
    { name: "Online active", count: 19 }, { name: "Online grace", count: 2 },
  ],
  total: 62,
  reviewCounts: { missing_membership_evidence: 7, duplicate_custom_values: 3, unresolved_organisation: 2 },
  excludedCounts: { outside_window: 11 },
};
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function mount({ access = accessFixture, loadingBranding = false, brandingId = BNMS_TENANT_ID, transport } = {}) {
  globalThis.__nmcReportFixture = { access, branding: { branding: { id: brandingId }, loading: loadingBranding } };
  downloads = []; createdUrls = []; revokedUrls = [];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.ok(String(url).startsWith(NMC_REPORT_ENDPOINT), `Unexpected endpoint: ${url}`);
    assert.equal(options.credentials, "include");
    assert.ok(options.signal instanceof AbortSignal);
    return transport ? transport(url, options) : jsonResponse(report);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    h(QueryClientProvider, { client },
      h(MemoryRouter, { initialEntries: ["/NMCMembershipReport"], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
        h(Routes, null,
          h(Route, { path: "/NMCMembershipReport", element: h(Page) }),
          h(Route, { path: "/Events", element: h("p", { "data-testid": "safe-destination" }, "Events") }),
        ),
      ),
    ),
  ));
  return {
    container, calls,
    async close() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

test("loading transitions to four worksheet counts with review diagnostics separate", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const view = await mount({ transport: () => pending });
  try {
    assert.ok(view.container.querySelector('[data-testid="nmc-report-loading"]'));
    assert.equal(view.calls.length, 1);
    await act(async () => resolve(jsonResponse(report)));
    await waitFor(() => view.container.querySelector('[data-testid="table-nmc-sheets"]'), "worksheet counts");
    assert.equal(view.container.querySelectorAll("tbody tr").length, 4);
    assert.equal(view.container.querySelector('[data-testid="text-nmc-total"]').textContent, "62");
    assert.equal(view.container.querySelector('[data-testid="text-report-date"]').textContent, "31 Mar 2026");
    const rows = [...view.container.querySelectorAll("tbody tr")].map(row => row.textContent);
    assert.deepEqual(rows, ["Print active37", "Print grace4", "Online active19", "Online grace2"]);
    const reviews = view.container.querySelector('[data-testid="list-nmc-review-reasons"]');
    assert.equal(reviews.querySelectorAll("li").length, 3);
    assert.match(reviews.textContent, /Missing membership evidence7/);
    assert.match(reviews.textContent, /Duplicate custom values3/);
    assert.match(reviews.textContent, /linked organisation/);
    assert.match(view.container.textContent, /diagnostics, not workbook rows/);
    assert.doesNotMatch(view.container.textContent, /Check the Review worksheet|in one read-only workbook/);
    assert.match(view.container.querySelector('[data-testid="list-nmc-excluded-reasons"]').textContent, /Outside window11/);
  } finally { await view.close(); }
});

test("summary error displays message and retry actually refetches", async () => {
  let attempts = 0;
  const view = await mount({ transport: () => ++attempts === 1 ? jsonResponse({ error: "Report service unavailable" }, 503) : jsonResponse(report) });
  try {
    await waitFor(() => view.container.querySelector('[data-testid="text-report-error"]'), "error");
    assert.match(view.container.textContent, /Report service unavailable/);
    const retry = [...view.container.querySelectorAll("button")].find(button => button.textContent === "Retry report");
    await act(async () => retry.click());
    await waitFor(() => view.container.querySelector('[data-testid="table-nmc-sheets"]'), "retried report");
    assert.equal(view.calls.length, 2);
  } finally { await view.close(); }
});

test("download click requests Excel, uses supplied filename, clicks attached link and revokes URL", async () => {
  const view = await mount({ transport: url => String(url).endsWith("?format=xlsx")
    ? new Response(new Uint8Array([80, 75, 3, 4]), { headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="bnms-2026-03-31.xlsx"',
    } }) : jsonResponse(report) });
  try {
    await waitFor(() => view.container.querySelector('[data-testid="table-nmc-sheets"]'), "report");
    await act(async () => view.container.querySelector('[data-testid="button-download-nmc-report"]').click());
    await waitFor(() => downloads.length === 1, "download click");
    assert.equal(view.calls[1].url, `${NMC_REPORT_ENDPOINT}?format=xlsx`);
    assert.deepEqual(downloads[0], { href: "blob:isolated-report-0", filename: "bnms-2026-03-31.xlsx", attached: true });
    assert.equal(view.container.querySelector('[data-testid="button-download-nmc-report"]').disabled, false);
    assert.equal(document.querySelectorAll("a[download]").length, 0);
    await waitFor(() => revokedUrls.length === 1, "object URL cleanup");
    assert.deepEqual(revokedUrls, createdUrls);
  } finally { await view.close(); }
});

test("download failure is visible, makes no download, and allows another attempt", async () => {
  const view = await mount({ transport: url => String(url).endsWith("?format=xlsx") ? jsonResponse({ error: "Workbook export failed" }, 500) : jsonResponse(report) });
  try {
    await waitFor(() => view.container.querySelector('[data-testid="table-nmc-sheets"]'), "report");
    await act(async () => view.container.querySelector('[data-testid="button-download-nmc-report"]').click());
    await waitFor(() => view.container.querySelector('[data-testid="text-export-error"]'), "download error");
    assert.match(view.container.textContent, /Workbook export failed/);
    assert.equal(downloads.length, 0);
    assert.equal(createdUrls.length, 0);
    assert.equal(view.container.querySelector('[data-testid="button-download-nmc-report"]').disabled, false);
    await act(async () => view.container.querySelector('[data-testid="button-download-nmc-report"]').click());
    assert.equal(view.calls.length, 3);
  } finally { await view.close(); }
});

test("non-BNMS, unvalidated, non-admin and feature-excluded identities never fetch", async () => {
  for (const options of [
    { brandingId: "another-tenant" },
    { access: { ...accessFixture, memberInfo: { id: "other-member", tenant_id: "another-tenant" } } },
    { access: { ...accessFixture, sessionValidated: false } },
    { access: { ...accessFixture, isAdmin: false } },
    { access: { ...accessFixture, isFeatureExcluded: id => id === NMC_REPORT_FEATURE } },
    { access: { ...accessFixture, isAdmin: true,
      memberInfo: { ...accessFixture.memberInfo, member_excluded_features: ["admin.role-management"] },
      isFeatureExcluded: id => id === "admin.role-management" } },
    // The existing member-access hook does not represent standalone tenant users.
    { access: { ...accessFixture, memberInfo: null, tenantUserId: "isolated-tenant-user" } },
  ]) {
    const view = await mount(options);
    try {
      await waitFor(() => view.container.querySelector('[data-testid="safe-destination"]'), "safe redirect");
      assert.equal(view.calls.length, 0);
    } finally { await view.close(); }
  }
});

test("unresolved identity stays skeletal without fetching; linked member admins use existing access", async () => {
  const pendingView = await mount({ access: { ...accessFixture, isAccessReady: false } });
  try {
    assert.ok(pendingView.container.querySelector('[data-testid="nmc-report-loading"]'));
    assert.equal(pendingView.calls.length, 0);
  } finally { await pendingView.close(); }
  const linkedView = await mount({ access: { ...accessFixture, memberInfo: { ...accessFixture.memberInfo, hasTenantUserLink: true } } });
  try {
    await waitFor(() => linkedView.container.querySelector('[data-testid="table-nmc-sheets"]'), "linked admin report");
    assert.equal(linkedView.calls.length, 1);
  } finally { await linkedView.close(); }
});

test("empty workbook keeps diagnostic explanations available", async () => {
  const view = await mount({ transport: () => jsonResponse({ ...report, total: 0, sheets: report.sheets.map(sheet => ({ ...sheet, count: 0 })) }) });
  try {
    await waitFor(() => view.container.querySelector('[data-testid="text-nmc-empty"]'), "empty state");
    assert.equal(view.container.querySelector('[data-testid="text-nmc-total"]').textContent, "0");
    assert.ok(view.container.querySelector('[data-testid="list-nmc-review-reasons"]'));
    assert.equal(view.container.querySelectorAll("tbody tr").length, 4);
  } finally { await view.close(); }
});
