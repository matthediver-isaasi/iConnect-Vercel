// Browser-only isolated fixture. Reuses the ALREADY RUNNING Vite server for
// modules/styles; all API calls and writes are intercepted. Starts no server.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const base = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000";
const origin = new URL(base).origin;
const path = "/__fixtures/task-4662-dashboard-builder";
const screenshot = process.env.SCREENSHOT_PATH || "/tmp/task-4662-dashboard-builder.png";
const transformed = await (await fetch(`${origin}/src/components/dashboard/WidgetBuilderModal.jsx`)).text();
const reactModule = transformed.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
if (!reactModule) throw new Error("The existing preview must serve Vite-transformed modules for this isolated fixture.");
const dependency = name => reactModule.replace(/react\.js\?/, `${name}.js?`);
const widget = {
  title: "Membership at month end", widget_type: "line", scope: "shared", width: "full",
  config: {
    source: "member_group",
    measure: { aggregator: "count", field: "period_end_members", fieldKind: "system" },
    timeBucket: { field: "membership_at", fieldKind: "system", granularity: "month", window: { amount: 4, unit: "month" } },
    seriesBy: { kind: "system", field: "group_id" },
    filters: [], cumulative: false,
  },
};
const sources = { sources: [{
  id: "member_group", label: "Member Groups",
  systemFields: [
    { name: "group_id", label: "Group", type: "reference" },
    { name: "group_name", label: "Group name", type: "text" },
    { name: "is_active", label: "Group active", type: "boolean" },
    { name: "group_role", label: "Membership role", type: "text" },
    { name: "membership_at", label: "Membership history date", type: "date" },
  ],
  customFields: [],
}] };
const payload = {
  type: "time", categories: ["group_a", "group_b"],
  seriesLabels: { group_a: "Clinical Group", group_b: "Research Group" },
  historyBaseline: "2026-07-01T00:00:00Z",
  rows: [
    { key: "2026-06", group_a: null, group_b: null, available: false },
    { key: "2026-07", group_a: 12, group_b: 8, available: true },
    { key: "2026-08", group_a: 15, group_b: 10, available: true },
    { key: "2026-09", group_a: 17, group_b: 11, available: true, provisional: true },
  ],
};
const html = `<!doctype html><html><head><title>Isolated Member Groups builder fixture</title></head>
<body><div id="root"></div><script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
await import("/@vite/client");
await import("/src/index.css");
const React = (await import("${reactModule}")).default;
const {createRoot} = (await import("${dependency("react-dom_client")}")).default;
const {QueryClient, QueryClientProvider} = await import("${dependency("@tanstack_react-query")}");
const {default: Builder} = await import("/src/components/dashboard/WidgetBuilderModal.jsx");
const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
createRoot(document.getElementById("root")).render(React.createElement(QueryClientProvider,{client},
  React.createElement(Builder,{open:true,initialWidget:${JSON.stringify(widget)},canSaveShared:true,
    onClose:()=>{},onSave:value=>{window.__savedWidget=value;}})));
</script></body></html>`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === path) return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/api/dashboard/sources") return json(sources);
    if (url.pathname === "/api/dashboard/widgets/preview") return json({ data: payload });
    if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(request.method())) return route.abort();
    return route.continue();
  });
  await page.goto(`${origin}${path}`);
  const save = page.getByTestId("button-save-widget");
  await save.waitFor().catch(error => { throw new Error(`${error.message}; page errors: ${JSON.stringify(errors)}`); });
  await page.getByTestId("member-group-report").waitFor();
  // Let Recharts finish drawing before capturing the real builder/preview.
  await page.waitForTimeout(1800);
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.getByTestId("member-group-semantics").locator("summary").click();
  assert.match(await page.getByTestId("member-group-semantics").textContent(), /Historical filters use CURRENT member attributes/);
  await save.click();
  const saved = await page.evaluate(() => window.__savedWidget);
  assert.equal(saved.scope, "shared");
  assert.deepEqual(saved.config.seriesBy, widget.config.seriesBy);
  assert.deepEqual(saved.config.timeBucket, widget.config.timeBucket);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ fixture: `${origin}${path}`, screenshot, result: "Builder rendered and saved named monthly series; no page errors." }));
} finally {
  await browser.close();
}