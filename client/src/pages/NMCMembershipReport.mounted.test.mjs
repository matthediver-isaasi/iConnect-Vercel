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
    const awaiting = view.container.querySelector('[data-testid="nmc-awaiting-first-payment"]');
    assert.match(awaiting.textContent, /Awaiting first payment5/);
    assert.match(awaiting.textContent, /not included in eligible totals or the workbook/);
    assert.match(awaiting.textContent, /Manual approval waits, failed collections/);
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
