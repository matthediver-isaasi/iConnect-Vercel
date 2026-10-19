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
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "HTMLInputElement", "Element", "Node", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "NodeFilter"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
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
  pendingCounts: { awaiting_first_payment: 5 },
  excludedCounts: { outside_window: 11 },
  settings: { printedClasses: ["full"], onlineClasses: ["associate"], revision: 3 },
  classOptions: [{ value: "full", label: "Full member" }, { value: "associate", label: "Associate" }, { value: "trainee", label: "Trainee" }],
  classCounts: {
    printed: [{ value: "full", label: "Full member", count: 41 }],
    online: [{ value: "associate", label: "Associate", count: 21 }],
  },
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
          h(Route, { path: "/members/:id", element: h("p", { "data-testid": "member-destination" }, "Member detail") }),
        ),
      ),
    ),
  ));
  return {
    container, calls, client,
    async rerenderAccess(nextAccess) {
      globalThis.__nmcReportFixture.access = nextAccess;
      await act(async () => root.render(h(QueryClientProvider, { client },
        h(MemoryRouter, { initialEntries: ["/NMCMembershipReport"], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
          h(Routes, null,
            h(Route, { path: "/NMCMembershipReport", element: h(Page) }),
            h(Route, { path: "/Events", element: h("p", { "data-testid": "safe-destination" }, "Events") }),
          ),
        ),
      )));
    },
    async close() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

test("payment stages and failures are inside review before fulfilment, with no standalone card", async () => {
  const view = await mount({ transport: async () => jsonResponse({ ...report,
    pendingCounts: { awaiting_mandate_setup: 1, first_collection_submitted: 2 },
    reviewCounts: { first_collection_failed: 2 },
  }) });
  try {
    await waitFor(() => view.container.querySelector('[data-testid="list-nmc-payment-progress"]'), "payment progress");
    const section = view.container.querySelector('[data-testid="nmc-review-before-fulfilment"]');
    assert.match(section.textContent, /Awaiting mandate \/ setup1/);
    assert.match(section.textContent, /First collection submitted — awaiting confirmation2/);
    assert.match(section.textContent, /First collection failed2/);
    assert.match(section.textContent, /not a normal setup wait/);
    assert.equal(view.container.querySelector('[data-testid="nmc-awaiting-first-payment"]'), null);
  } finally { await view.close(); }
});

test("loading transitions to recipient worksheet counts with review diagnostics separate", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const view = await mount({ transport: () => pending });
  try {
    assert.ok(view.container.querySelector('[data-testid="nmc-report-loading"]'));
    assert.equal(view.calls.length, 1);
    await act(async () => resolve(jsonResponse(report)));
    await waitFor(() => view.container.querySelector('[data-testid="table-nmc-sheets"]'), "worksheet counts");
    assert.equal(view.container.querySelectorAll('[data-testid="table-nmc-sheets"] tbody tr').length, 4);
    assert.equal(view.container.querySelector('[data-testid="text-nmc-total"]').textContent, "62");
    assert.equal(view.container.querySelector('[data-testid="nmc-awaiting-first-payment"]'), null);
    const awaiting = view.container.querySelector('[data-testid="nmc-review-before-fulfilment"] [data-testid="list-nmc-payment-progress"]');
    assert.match(awaiting.textContent, /First collection pending5/);
    assert.match(awaiting.textContent, /not included in the workbook/);
    assert.equal(view.container.querySelector('[data-testid="text-report-date"]').textContent, "31 Mar 2026");
    const rows = [...view.container.querySelectorAll('[data-testid="table-nmc-sheets"] tbody tr')].map(row => row.textContent);
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
    assert.equal(view.container.querySelectorAll('[data-testid="table-nmc-sheets"] tbody tr').length, 4);
  } finally { await view.close(); }
});

const byTestId = (view, id) => view.container.querySelector(`[data-testid="${id}"]`);
async function click(view, id) {
  const element = byTestId(view, id);
  assert.ok(element, `Missing ${id}`);
  await act(async () => element.click());
}
async function openSettings(view) {
  await waitFor(() => byTestId(view, "table-nmc-sheets"), "loaded report");
  await click(view, "tab-nmc-settings");
  await waitFor(() => byTestId(view, "nmc-printedClasses-full"), "saved settings");
}

test("saved class count tables use natural labels and no obsolete fulfilment rules", async () => {
  const view = await mount();
  try {
    await waitFor(() => byTestId(view, "table-nmc-printed-classes"), "class count tables");
    assert.match(byTestId(view, "table-nmc-printed-classes").textContent, /Full member41/);
    assert.match(byTestId(view, "table-nmc-online-classes").textContent, /Associate21/);
    assert.doesNotMatch(view.container.textContent, /Four fulfilment worksheets|All non-NMC membership classes are Online-only/);
    assert.match(view.container.textContent, /exactly 90 days, not three months/);
  } finally { await view.close(); }
});

test("class selections move between groups, save explicitly with revision, and refresh report", async () => {
  let current = report;
  let completeSave;
  const view = await mount({ transport: async (_url, options) => {
    if (options.method === "PUT") {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload, { printedClasses: ["full", "associate"], onlineClasses: [], revision: 3 });
      await new Promise(resolve => { completeSave = resolve; });
      current = { ...report, settings: { ...payload, revision: 4 } };
      return jsonResponse({ settings: current.settings });
    }
    return jsonResponse(current);
  } });
  try {
    await openSettings(view);
    assert.equal(byTestId(view, "nmc-onlineClasses-associate").checked, true);
    await click(view, "nmc-printedClasses-associate");
    assert.equal(byTestId(view, "nmc-onlineClasses-associate").checked, false);
    assert.equal(view.calls.length, 1, "editing must not save automatically");
    assert.equal(byTestId(view, "button-refresh-nmc-report").disabled, true);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, true);
    await click(view, "button-save-nmc-settings");
    await waitFor(() => completeSave, "save request");
    assert.equal(byTestId(view, "button-save-nmc-settings").disabled, true);
    assert.equal(byTestId(view, "nmc-printedClasses-full").closest("fieldset").disabled, true);
    assert.equal(byTestId(view, "button-refresh-nmc-report").disabled, true);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, true);
    await act(async () => completeSave());
    await waitFor(() => byTestId(view, "text-nmc-settings-success"), "saved settings");
    assert.equal(view.calls.length, 3, "save must refresh the report");
    assert.equal(view.calls[1].options.method, "PUT");
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, false);
    assert.equal(byTestId(view, "button-save-nmc-settings").disabled, true);
  } finally { await view.close(); }
});

test("empty selections and unavailable saved values are preserved until explicitly removed", async () => {
  const saved = { ...report, settings: { printedClasses: ["full", "legacy-class"], onlineClasses: [], revision: 7 } };
  let payload;
  const view = await mount({ transport: (_url, options) => {
    if (options.method === "PUT") {
      payload = JSON.parse(options.body);
      return jsonResponse({ settings: { ...payload, revision: 8 } });
    }
    return jsonResponse(payload ? { ...saved, settings: { ...payload, revision: 8 } } : saved);
  } });
  try {
    await openSettings(view);
    assert.equal(byTestId(view, "nmc-printedClasses-legacy-class").checked, true);
    assert.match(view.container.textContent, /Unavailable saved class/);
    await click(view, "nmc-printedClasses-full");
    await click(view, "button-save-nmc-settings");
    await waitFor(() => byTestId(view, "text-nmc-settings-success"), "unknown preserved");
    assert.deepEqual(payload, { printedClasses: ["legacy-class"], onlineClasses: [], revision: 7 });
    await click(view, "nmc-printedClasses-legacy-class");
    await click(view, "button-save-nmc-settings");
    await waitFor(() => payload?.revision === 8 && byTestId(view, "button-save-nmc-settings").disabled, "empty selections saved");
    assert.deepEqual(payload, { printedClasses: [], onlineClasses: [], revision: 8 });
  } finally { await view.close(); }
});

test("save errors retain edits, permit retry and allow discard without a PUT", async () => {
  const view = await mount({ transport: (_url, options) => options.method === "PUT" ? jsonResponse({ error: "Please review these classes" }, 400) : jsonResponse(report) });
  try {
    await openSettings(view);
    await click(view, "nmc-printedClasses-trainee");
    await click(view, "button-save-nmc-settings");
    await waitFor(() => byTestId(view, "text-nmc-settings-error"), "save error");
    assert.match(byTestId(view, "text-nmc-settings-error").textContent, /Please review these classes/);
    assert.equal(byTestId(view, "nmc-printedClasses-trainee").checked, true);
    assert.equal(byTestId(view, "button-save-nmc-settings").disabled, false);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, true);
    await click(view, "button-save-nmc-settings");
    await waitFor(() => view.calls.length === 3 && byTestId(view, "text-nmc-settings-error"), "retry");
    await click(view, "button-discard-nmc-settings");
    assert.equal(byTestId(view, "nmc-printedClasses-trainee").checked, false);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, false);
    assert.equal(view.calls.length, 3);
  } finally { await view.close(); }
});

test("409 prevents further saves and exports until explicitly reloading latest settings", async () => {
  let reads = 0;
  const latest = { ...report, settings: { printedClasses: ["trainee"], onlineClasses: ["full"], revision: 9 } };
  const view = await mount({ transport: (_url, options) => {
    if (options.method === "PUT") return jsonResponse({ error: "Conflict" }, 409);
    return jsonResponse(++reads === 1 ? report : latest);
  } });
  try {
    await openSettings(view);
    await click(view, "nmc-printedClasses-associate");
    await click(view, "button-save-nmc-settings");
    await waitFor(() => byTestId(view, "button-reload-nmc-settings"), "conflict reload");
    assert.match(byTestId(view, "text-nmc-settings-error").textContent, /Another administrator/);
    assert.equal(byTestId(view, "button-save-nmc-settings").disabled, true);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, true);
    assert.equal(byTestId(view, "button-refresh-nmc-report").disabled, true);
    await click(view, "button-save-nmc-settings");
    assert.equal(view.calls.length, 2);
    await click(view, "button-reload-nmc-settings");
    await waitFor(() => !byTestId(view, "button-reload-nmc-settings"), "conflict resolved");
    assert.equal(byTestId(view, "nmc-printedClasses-associate").checked, false);
    assert.equal(byTestId(view, "nmc-printedClasses-trainee").checked, true);
    assert.equal(byTestId(view, "nmc-onlineClasses-full").checked, true);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, false);
  } finally { await view.close(); }
});

test("failed conflict reload preserves local selections and stays blocked until reload succeeds", async () => {
  let reads = 0;
  const view = await mount({ transport: (_url, options) => {
    if (options.method === "PUT") return jsonResponse({ error: "Conflict" }, 409);
    reads += 1;
    return reads === 2 ? jsonResponse({ error: "Unavailable" }, 503) : jsonResponse(report);
  } });
  try {
    await openSettings(view);
    await click(view, "nmc-printedClasses-trainee");
    await click(view, "button-save-nmc-settings");
    await waitFor(() => byTestId(view, "button-reload-nmc-settings"), "conflict");
    await click(view, "button-reload-nmc-settings");
    await waitFor(() => byTestId(view, "text-nmc-settings-error")?.textContent.includes("Could not reload"), "reload failure");
    assert.equal(byTestId(view, "nmc-printedClasses-trainee").checked, true);
    assert.equal(byTestId(view, "button-save-nmc-settings").disabled, true);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, true);
    await click(view, "button-reload-nmc-settings");
    await waitFor(() => !byTestId(view, "button-reload-nmc-settings"), "reload retry");
    assert.equal(byTestId(view, "nmc-printedClasses-trainee").checked, false);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, false);
  } finally { await view.close(); }
});

test("saved settings with a failed report refresh block export until report retry succeeds", async () => {
  let reads = 0;
  let settings = report.settings;
  const view = await mount({ transport: (_url, options) => {
    if (options.method === "PUT") {
      settings = { ...JSON.parse(options.body), revision: 4 };
      return jsonResponse({ settings });
    }
    reads += 1;
    return reads === 2 ? jsonResponse({ error: "Snapshot unavailable" }, 503) : jsonResponse({ ...report, settings });
  } });
  try {
    await openSettings(view);
    await click(view, "nmc-printedClasses-trainee");
    await click(view, "button-save-nmc-settings");
    await waitFor(() => byTestId(view, "text-nmc-settings-success"), "saved with report failure");
    assert.match(byTestId(view, "text-nmc-settings-success").textContent, /settings saved.*could not be refreshed/);
    assert.equal(byTestId(view, "button-download-nmc-report").disabled, true);
    assert.equal(byTestId(view, "button-save-nmc-settings").disabled, true);
    await click(view, "button-refresh-nmc-report");
    await waitFor(() => !byTestId(view, "button-download-nmc-report").disabled, "report recovery");
    assert.equal(byTestId(view, "nmc-printedClasses-trainee").checked, true);
  } finally { await view.close(); }
});

const reviewReasons = ["first_collection_failed", "missing_membership_evidence", "missing_class", "unknown_class", "duplicate_custom_values", "unresolved_organisation", "invalid_expiry_or_term", "missing_expiry", "unproven_membership_evidence", "ambiguous_membership_evidence", "new_backend_reason"];
const pendingReasons = ["awaiting_mandate_setup", "first_collection_submitted", "awaiting_first_payment"];
const diagnosticRow = (id, overrides = {}) => ({ memberId: id, firstName: "Leah", lastName: "Shaw", email: "leah@example.test", memberClass: "Full member", ...overrides });
const drillReport = (rows = [diagnosticRow("m-001")]) => ({
  ...report,
  reviewCounts: Object.fromEntries(reviewReasons.map(reason => [reason, rows.length])),
  pendingCounts: Object.fromEntries(pendingReasons.map(reason => [reason, rows.length])),
  diagnostics: {
    review: Object.fromEntries(reviewReasons.map(reason => [reason, rows])),
    pending: Object.fromEntries(pendingReasons.map(reason => [reason, rows])),
  },
});
const dialog = () => document.querySelector('[data-testid="nmc-diagnostic-dialog"]');
const dialogButton = name => [...dialog().querySelectorAll("button")].find(button => button.textContent === name);
async function openDrill(view, group = "review", reason = "missing_class") {
  await waitFor(() => byTestId(view, `nmc-drilldown-${group}-${reason}`), "drilldown count");
  await click(view, `nmc-drilldown-${group}-${reason}`);
  await waitFor(dialog, "diagnostic dialog");
}
async function closeDrill() {
  await act(async () => dialogButton("Close").click());
  await waitFor(() => !dialog(), "closed dialog");
}

test("every review and pending reason opens the shared read-only dialog with guidance and member routing", async () => {
  const view = await mount({ transport: () => jsonResponse(drillReport()) });
  try {
    for (const [group, reasons] of [["review", reviewReasons], ["pending", pendingReasons]]) {
      for (const reason of reasons) {
        await openDrill(view, group, reason);
        assert.match(dialog().querySelector("h2").textContent, /1 members/);
        assert.ok(dialog().getAttribute("aria-describedby"));
        assert.match(dialog().textContent, /Leah Shaw/);
        assert.equal(dialog().querySelector("a").getAttribute("href"), "/members/m-001");
        await closeDrill();
        await waitFor(() => document.activeElement === byTestId(view, `nmc-drilldown-${group}-${reason}`), "restored trigger focus");
      }
    }
    assert.equal(view.calls.length, 1, "opening and closing never fetch or write");
    await openDrill(view);
    // Dispatch rather than the test harness's download-only anchor .click override.
    await act(async () => dialog().querySelector("a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    await waitFor(() => byTestId(view, "member-destination"), "established member route");
    assert.equal(dialog(), null);
    assert.ok(view.calls.every(call => !call.options.method));
  } finally { await view.close(); }
});

test("native count buttons support keyboard activation, Escape closes and restores focus", async () => {
  const view = await mount({ transport: () => jsonResponse(drillReport()) });
  try {
    await waitFor(() => byTestId(view, "nmc-drilldown-review-missing_class"), "count");
    const trigger = byTestId(view, "nmc-drilldown-review-missing_class");
    assert.equal(trigger.tagName, "BUTTON");
    assert.equal(trigger.disabled, false);
    trigger.focus();
    // JSDOM has no native keyboard default actions; emulate the browser's
    // Enter/Space-generated click after checking the native button semantics.
    for (const key of ["Enter", " "]) {
      await act(async () => {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        trigger.click();
        trigger.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      });
      await waitFor(dialog, "keyboard-opened dialog");
      assert.ok(dialog().contains(document.activeElement), "Radix moves focus into the modal");
      const close = dialogButton("Close");
      close.focus();
      await act(async () => close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
      assert.ok(dialog().contains(document.activeElement), "Tab cannot leave the modal");
      await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await waitFor(() => !dialog(), "Escape close");
      await waitFor(() => document.activeElement === trigger, "focus restoration");
    }
  } finally { await view.close(); }
});

test("deterministic 25-row pagination, partial identity fallbacks, zero and unavailable lists", async () => {
  const rows = Array.from({ length: 53 }, (_, i) => diagnosticRow(`m-${String(52 - i).padStart(3, "0")}`));
  rows.push(diagnosticRow("missing", { firstName: null, lastName: null, email: null, memberClass: null }));
  rows.push(diagnosticRow("partial", { firstName: null, lastName: "Zed", email: "", memberClass: null }));
  const snapshot = drillReport(rows);
  snapshot.reviewCounts.zero_reason = 0;
  snapshot.diagnostics.review.zero_reason = [];
  snapshot.reviewCounts.unavailable_reason = 2;
  snapshot.diagnostics.review.unavailable_reason = [diagnosticRow("duplicate"), diagnosticRow("duplicate")];
  const view = await mount({ transport: () => jsonResponse(snapshot) });
  try {
    await openDrill(view);
    assert.equal(dialog().querySelectorAll("tbody tr").length, 25);
    assert.match(dialog().textContent, /Name unavailable.*Email unavailable.*Class missing or ambiguous/);
    assert.match(dialog().textContent, /1–25 of 55/);
    assert.equal(dialogButton("Previous").disabled, true);
    assert.equal(dialog().querySelector("tbody a").getAttribute("href"), "/members/missing");
    await act(async () => dialogButton("Next").click());
    assert.equal(dialog().querySelectorAll("tbody tr").length, 25);
    assert.match(dialog().textContent, /26–50 of 55/);
    await act(async () => dialogButton("Next").click());
    assert.equal(dialog().querySelectorAll("tbody tr").length, 5);
    assert.match(dialog().textContent, /Zed \(partial name\)/);
    assert.equal(dialogButton("Next").disabled, true);
    await act(async () => dialogButton("Previous").click());
    assert.match(dialog().textContent, /26–50 of 55/);
    await closeDrill();
    await openDrill(view, "pending", "awaiting_first_payment");
    assert.match(dialog().textContent, /1–25 of 55/);
    await closeDrill();
    await openDrill(view, "review", "zero_reason");
    assert.match(dialog().textContent, /0 members.*No members have this reason/s);
    await closeDrill();
    await openDrill(view, "review", "unavailable_reason");
    assert.match(dialog().textContent, /2 members.*details are unavailable/s);
    assert.equal(dialog().querySelector("table"), null);
    assert.equal(view.calls.length, 1);
  } finally { await view.close(); }
});

test("absent, malformed and incomplete lists never render a misleading empty or partial table", async () => {
  const variants = [
    undefined, null, {}, [], [diagnosticRow("m", { memberId: null })],
    [diagnosticRow("m", { email: 7 })],
  ];
  for (const rows of variants) {
    const snapshot = drillReport();
    snapshot.diagnostics.review.missing_class = rows;
    const view = await mount({ transport: () => jsonResponse(snapshot) });
    try {
      await openDrill(view);
      assert.match(dialog().textContent, /details are unavailable/);
      assert.doesNotMatch(dialog().textContent, /No members have/);
      assert.equal(dialog().querySelector("a"), null);
    } finally { await view.close(); }
  }
});

test("refresh closes immediately and never reopens after equal-data success or failure", async () => {
  for (const fail of [false, true]) {
    let resolveRefresh;
    let reads = 0;
    const snapshot = drillReport();
    const view = await mount({ transport: () => ++reads === 1 ? jsonResponse(snapshot) : new Promise(resolve => { resolveRefresh = resolve; }) });
    try {
      await openDrill(view);
      // External refetch is important: it does not use the page's reset handler.
      await act(async () => { void view.client.refetchQueries({ queryKey: ["nmc-membership-report"] }); });
      assert.equal(dialog(), null, "stale identities disappear during fetching");
      assert.equal(byTestId(view, "nmc-drilldown-review-missing_class").disabled, true);
      await act(async () => resolveRefresh(fail ? jsonResponse({ error: "Snapshot unavailable" }, 503) : jsonResponse(snapshot)));
      await waitFor(() => fail ? byTestId(view, "text-report-error") : !byTestId(view, "nmc-drilldown-review-missing_class").disabled, "refresh settled");
      assert.equal(dialog(), null);
      if (!fail) {
        await openDrill(view);
        assert.match(dialog().textContent, /Leah Shaw/);
      }
      assert.equal(view.calls.length, 2);
      assert.ok(view.calls.every(call => !call.options.method));
    } finally { await view.close(); }
  }
});

test("cache snapshot changes reset selection even when structural sharing retains identical data", async () => {
  const snapshot = drillReport();
  const view = await mount({ transport: () => jsonResponse(snapshot) });
  try {
    await openDrill(view);
    const key = ["nmc-membership-report", BNMS_TENANT_ID, accessFixture.memberInfo.id];
    const before = view.client.getQueryData(key);
    await act(async () => view.client.setQueryData(key, structuredClone(snapshot)));
    assert.equal(view.client.getQueryData(key), before, "React Query retained equal-data reference");
    assert.equal(dialog(), null, "update counter invalidated selection");
    await openDrill(view);
    await act(async () => view.client.setQueryData(key, drillReport([diagnosticRow("other", { firstName: "Ravi" })])));
    assert.equal(dialog(), null);
    await openDrill(view);
    assert.match(dialog().textContent, /Ravi Shaw/);
  } finally { await view.close(); }
});

test("tab departure, settings save, access loss and unmount clear diagnostic identities", async () => {
  let settings = report.settings;
  const view = await mount({ transport: (_url, options) => {
    if (options.method === "PUT") {
      settings = { ...JSON.parse(options.body), revision: 4 };
      return jsonResponse({ settings });
    }
    return jsonResponse({ ...drillReport(), settings });
  } });
  let closed = false;
  try {
    await openDrill(view);
    await click(view, "tab-nmc-settings");
    assert.equal(dialog(), null);
    await click(view, "nmc-printedClasses-trainee");
    await click(view, "button-save-nmc-settings");
    await waitFor(() => byTestId(view, "text-nmc-settings-success"), "settings saved");
    assert.equal(dialog(), null);
    const reportTab = [...view.container.querySelectorAll("button")].find(button => button.textContent === "Report");
    await act(async () => reportTab.click());
    assert.equal(dialog(), null);
    await openDrill(view);
    await view.rerenderAccess({ ...accessFixture, isAdmin: false });
    assert.equal(dialog(), null);
    await waitFor(() => byTestId(view, "safe-destination"), "access-loss redirect");
    assert.equal(view.calls.filter(call => call.options.method === "PUT").length, 1, "only explicit save writes");
    await view.close(); closed = true;
    assert.equal(dialog(), null);
  } finally { if (!closed) await view.close(); }
  const unmounted = await mount({ transport: () => jsonResponse(drillReport()) });
  await openDrill(unmounted);
  await unmounted.close();
  assert.equal(dialog(), null);
});
