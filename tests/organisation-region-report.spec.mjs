import { test, expect } from "@playwright/test";

// Served real builder with isolated schema, discovery and local save fixtures.
// All API requests are intercepted: this does not verify live authentication.
test("Organisation Region discovery survives saving and reopening the real builder", async ({ page, baseURL }) => {
  const errors = [];
  const discovery = [];
  page.on("pageerror", error => errors.push(error.message));
  const origin = new URL(baseURL).origin;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/custom-objects/department/report-organization-fields") {
      discovery.push(url.pathname);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        data: [{ id: "region-field", label: "Region", field_type: "text" }],
      }) });
    }
    if (url.origin !== origin || url.pathname.startsWith("/api/"))
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    if (url.pathname === "/__organisation-region-report-fixture")
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
const source = await (await fetch('/src/pages/customObjects/CustomObjectReports.jsx')).text();
const dep = name => source.match(new RegExp('from "([^"]*/'+name+'\\\\.js[^"]*)"'))[1];
const React = (await import(dep('react'))).default;
const {createRoot} = (await import(dep('react').replace(/react\\.js/, 'react-dom_client.js'))).default;
const {QueryClient,QueryClientProvider} = await import(dep('@tanstack_react-query'));
const {CustomObjectReports} = await import('/src/pages/customObjects/CustomObjectReports.jsx');
await import('/src/index.css');
const object = {id:'department',plural_label:'Departments'};
const definitions = [{id:'organisations',status:'active',source_kind:'custom_object',source_custom_object_id:'department',target_kind:'organization',source_label:'Organisations',relationship_key:'organisations'}];
const initial = JSON.parse(localStorage.getItem('fixture-region-report') || 'null') || {version:2,start_object_id:'department',start_endpoint:{kind:'custom_object',customObjectId:'department'},grain_path:[],include_empty:false,columns:[]};
let latest;
const saved = {reports:[],activeReportId:null,activeReport:null,isSaving:false,setActiveReportId(){}};
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},
React.createElement('main',{style:{padding:24}},React.createElement(CustomObjectReports,{object,fields:[],definitions,canManage:true,initialConfig:initial,savedReports:saved,onConfigChange:value=>{latest=value;window.fixtureConfig=value}}),
React.createElement('button',{onClick:()=>localStorage.setItem('fixture-region-report',JSON.stringify(latest))},'Fixture save'))));
</script></body></html>` });
    return route.continue();
  });
  await page.goto("/__organisation-region-report-fixture");
  await page.getByTestId("add-report-column").click();
  await page.getByTestId("report-column-kind").selectOption("related_field");
  await page.getByRole("button", { name: "Related records from starting entity", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /organisations/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Use / }).click();
  await expect(page.getByRole("button", { name: "Name", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Region", exact: true }).click();
  await expect(page.getByTestId("column-heading-0")).toHaveValue("Region");
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  const config = await page.evaluate(() => window.fixtureConfig);
  expect(config.columns[0]).toMatchObject({
    kind: "field", preference_field_id: "region-field", label: "Region",
    path: [{ relationship_definition_id: "organisations", from_side: "source" }],
  });
  expect(config.columns[0]).not.toHaveProperty("field");
  expect(config.columns[0]).not.toHaveProperty("field_id");
  await page.getByRole("button", { name: "Fixture save", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("column-heading-0")).toHaveValue("Region");
  await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.fixtureConfig)).toEqual(config);
  expect(discovery).toHaveLength(2);
  await page.screenshot({ path: "test-results/organisation-region-report/builder.png", fullPage: true });
  expect(errors).toEqual([]);
});
