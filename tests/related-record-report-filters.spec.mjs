import { test, expect } from "@playwright/test";

// Browser-mounted real builder with isolated schema and save storage.
// All API traffic is blocked; this is not authenticated/live verification.
test("Department None-match configuration survives saving and reopening", async ({ page, baseURL }) => {
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  const origin = new URL(baseURL).origin;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith("/api/"))
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    if (url.pathname === "/__report-filter-fixture")
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
const definitions = [{id:'members',status:'active',source_kind:'custom_object',source_custom_object_id:'department',target_kind:'member',source_label:'Members',relationship_key:'members',configuration:{relationship_fields:[{id:'responder',key:'survey_respondent',label:'Survey respondent',type:'boolean',display_on_source:true}]}}];
const initial = JSON.parse(localStorage.getItem('fixture-report') || 'null') || {version:2,start_object_id:'department',start_endpoint:{kind:'custom_object',customObjectId:'department'},grain_path:[],include_empty:false,columns:[{kind:'field',path:[],field_id:'name',label:'Department'}]};
let latest;
const saved = {reports:[],activeReportId:null,activeReport:null,isSaving:false,setActiveReportId(){}};
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},
React.createElement('main',{style:{padding:24}},React.createElement(CustomObjectReports,{object,fields:[{id:'name',name:'name',label:'Department name',field_type:'text',is_active:true}],definitions,canManage:true,initialConfig:initial,savedReports:saved,onConfigChange:value=>{latest=value;window.fixtureConfig=value}}),
React.createElement('button',{onClick:()=>localStorage.setItem('fixture-report',JSON.stringify(latest))},'Fixture save'))));
</script></body></html>` });
    return route.continue();
  });
  await page.goto("/__report-filter-fixture");
  await page.getByTestId("add-report-filter").click();
  await page.getByRole("combobox", { name: "Filter 1 match mode", exact: true }).click();
  await page.getByRole("option", { name: "None match", exact: true }).click();
  await page.getByTestId("add-filter-condition-0").click();
  await page.getByRole("combobox", { name: "Filter 1 condition 1 field", exact: true }).click();
  await page.getByRole("option", { name: /Relationship: Survey respondent/ }).click();
  await expect(page.getByRole("combobox", { name: "Filter 1 condition 1 value", exact: true })).toHaveText("Yes");
  const config = await page.evaluate(() => window.fixtureConfig);
  expect(config.filters[0]).toMatchObject({
    mode: "none", path: [{ relationship_definition_id: "members", from_side: "source" }],
    conditions: [{ kind: "relationship_field", relationship_field_id: "responder", op: "equals", value: true }],
  });
  await page.getByRole("button", { name: "Fixture save", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Filter 1 match mode", exact: true })).toHaveText("None match");
  await expect(page.getByRole("combobox", { name: "Filter 1 condition 1 value", exact: true })).toHaveText("Yes");
  await page.screenshot({ path: "test-results/related-record-report-filters/builder.png", fullPage: true });
  expect(errors).toEqual([]);
});