import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Adapted from the existing related-record-report-filters fixture: the actual
// Vite-compiled builder is mounted, but every API and external request is
// intercepted. No login, tenant data, database, or production requests.
async function fixture(page, baseURL) {
  const errors = [];
  const previewRequests = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  const origin = new URL(baseURL).origin;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.fulfill({ status: 200, body: "" });
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname.endsWith("/report-preview")) {
        const request = route.request().postDataJSON();
        previewRequests.push(request);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          headers: request.definition.columns.map((column) => column.label),
          rows: [["Clinical sciences", "North association", 3, "True"], ["Imaging", "", 0, "False"]],
          total: 2, has_more: false,
        }) });
      }
      if (url.pathname.endsWith("/report-export")) return route.fulfill({
        contentType: "application/json", body: JSON.stringify({
          legacy_sync: true, filename: "departments.csv",
          csv: "Department,Organisation,Member count,Has survey responder\nClinical sciences,North association,3,True\nImaging,,0,False\n",
        }),
      });
      if (url.pathname.includes("/project/fields")) return route.fulfill({
        status: 503, contentType: "application/json", body: '{"message":"Fixture metadata unavailable"}',
      });
      return route.fulfill({ contentType: "application/json", body: "[]" });
    }
    if (url.pathname !== "/__report-5022-fixture") return route.continue();
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
const long = localStorage.getItem('fixture-long') === 'yes';
const longName = 'DepartmentalInterdisciplinaryRelationshipDesignation'.repeat(8);
const object = {id:'department',singular_label:'Department',plural_label:long ? longName : 'Departments'};
const definitions = [
{id:'members',status:'active',source_kind:'custom_object',source_custom_object_id:'department',target_kind:'member',source_label:long ? longName : 'Department members',relationship_key:'department_members',configuration:{relationship_fields:[{id:'responder',key:'survey_respondent',label:long ? longName : 'Survey responder',type:'boolean'}]}},
{id:'mentors',status:'active',source_kind:'custom_object',source_custom_object_id:'department',target_kind:'member',source_label:'Department mentors',relationship_key:'department_mentors'},
{id:'organisations',status:'active',source_kind:'custom_object',source_custom_object_id:'department',target_kind:'organization',source_label:'Linked organisations',relationship_key:'department_organisation'},
{id:'member-org',status:'active',source_kind:'member',target_kind:'organization',source_label:'Member organisations',relationship_key:'member_organisation'},
{id:'projects',status:'active',source_kind:'custom_object',source_custom_object_id:'department',target_kind:'custom_object',target_custom_object_id:'project',source_label:'Projects',relationship_key:'department_projects'}
];
const initial = JSON.parse(localStorage.getItem('fixture-report') || 'null') || {version:2,start_object_id:'department',start_endpoint:{kind:'custom_object',customObjectId:'department'},grain_path:[],include_empty:false,columns:[],multi_value:'join'};
const client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
if (localStorage.getItem('fixture-metadata-error') !== 'yes') client.setQueryData(['custom-object-report-fields','project'],[]);
let latest;
const saved = {reports:[],activeReportId:null,activeReport:null,isSaving:false,setActiveReportId(){}};
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},
React.createElement('main',{style:{padding:long ? 12 : 24,maxWidth:1000,margin:'auto',minWidth:0}},
React.createElement(CustomObjectReports,{object,fields:[{id:'name',label:long ? longName : 'Department name',field_type:'text',is_active:true}],definitions:{data:definitions,objects:[{id:'project',plural_label:'Projects'}]},canManage:true,initialConfig:initial,savedReports:saved,onConfigChange:value=>{latest=value;window.fixtureConfig=value}}),
React.createElement('button',{onClick:()=>localStorage.setItem('fixture-report',JSON.stringify(latest))},'Fixture save'))));
</script></body></html>` });
  });
  await page.goto("/__report-5022-fixture");
  await expect(page.getByTestId("add-report-column")).toBeVisible({ timeout: 15000 });
  return { errors, previewRequests };
}

async function openColumn(page, kind) {
  const add = page.getByTestId("add-report-column");
  if (await add.getAttribute("aria-expanded") !== "true") await add.click();
  await page.getByTestId("report-column-kind").selectOption(kind);
}

async function selectRelated(page, kind, key) {
  await openColumn(page, kind);
  await page.getByRole("button", {
    name: kind === "related_field" ? "Related records from starting entity" : "Related records from each row", exact: true,
  }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Search relationships" }).fill(key);
  await dialog.getByRole("button").filter({ hasText: key }).click();
  await dialog.getByRole("button", { name: /^Use / }).click();
}

test("complete four-column department report saves/reopens, previews and exports without row filtering", async ({ page, baseURL }, testInfo) => {
  const { errors, previewRequests } = await fixture(page, baseURL);
  await openColumn(page, "field");
  await page.getByRole("button", { name: "Department name", exact: true }).click();
  await selectRelated(page, "related_field", "department_organisation");
  await page.getByRole("button", { name: "Name", exact: true }).click();
  await selectRelated(page, "count_distinct", "department_members");
  await page.getByTestId("add-report-count").click();
  await selectRelated(page, "exists_related", "department_members");
  await page.getByTestId("add-report-indicator").click();
  await page.getByTestId("column-heading-0").fill("Department");
  await page.getByTestId("column-heading-1").fill("Organisation");
  await page.getByTestId("column-heading-2").fill("Member count");
  await page.getByTestId("column-heading-3").fill("Has survey responder");
  const editor = page.getByTestId("report-indicator-conditions");
  await editor.getByTestId("add-indicator-condition").click();
  await editor.getByRole("combobox", { name: "Indicator column 4 condition 1 field", exact: true }).click();
  await page.getByRole("option", { name: "Relationship: Survey responder", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "Indicator column 4 condition 1 value", exact: true })).toHaveText("Yes");
  await expect(editor.getByRole("combobox", { name: /match mode/ })).toHaveCount(0);
  const definition = await page.evaluate(() => window.fixtureConfig);
  expect(definition.grain_path).toEqual([]);
  expect(definition.filters).toBeUndefined();
  expect(definition.columns.map((column) => column.kind)).toEqual(["field", "field", "count_distinct", "exists_related"]);
  expect(definition.columns[3].mode).toBeUndefined();
  expect(definition.columns[3].conditions).toEqual([
    { kind: "relationship_field", relationship_field_id: "responder", op: "equals", value: true },
  ]);
  expect(definition.columns[2].path).toEqual(definition.columns[3].path);
  await page.getByRole("button", { name: "Fixture save", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("column-heading-3")).toHaveValue("Has survey responder");
  expect(await page.evaluate(() => window.fixtureConfig)).toEqual(definition);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("cell", { name: "True", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "False", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "0", exact: true })).toBeVisible();
  expect(previewRequests[0].definition).toEqual(definition);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const download = await downloaded;
  const file = testInfo.outputPath("departments.csv");
  await download.saveAs(file);
  const csv = await readFile(file, "utf8");
  expect(csv).toContain("Clinical sciences,North association,3,True");
  expect(csv).toContain("Imaging,,0,False");
  await page.screenshot({ path: testInfo.outputPath("four-column-report.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("progressive search, same-destination distinction, back, keyboard selection and focus return", async ({ page, baseURL }) => {
  const { errors } = await fixture(page, baseURL);
  await openColumn(page, "count_distinct");
  const trigger = page.getByRole("button", { name: "Related records from each row", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  const search = dialog.getByRole("textbox", { name: "Search relationships" });
  await expect(search).toBeFocused();
  await search.fill("department_members");
  await search.press("Tab");
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
  await search.fill("member_organisation");
  await search.press("Tab");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Use Organisation", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Use Member", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await search.fill("department_mentors");
  await expect(dialog.getByRole("button").filter({ hasText: "department_mentors" })).toBeVisible();
  await expect(dialog.getByRole("button").filter({ hasText: "department_members" })).toHaveCount(0);
  await dialog.getByRole("button").filter({ hasText: "department_mentors" }).focus();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Use Member", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await page.getByTestId("add-report-count").click();
  expect((await page.evaluate(() => window.fixtureConfig)).columns[0].path).toEqual([
    { relationship_definition_id: "mentors", from_side: "source" },
  ]);
  await openColumn(page, "exists_related");
  await trigger.click();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByTestId("add-report-filter").click();
  await page.getByRole("button", { name: "Filter 1 related path", exact: true }).click();
  await search.fill("member_organisation");
  await dialog.getByRole("button").filter({ hasText: "member_organisation" }).click();
  await dialog.getByRole("button", { name: "Use Organisation", exact: true }).click();
  expect((await page.evaluate(() => window.fixtureConfig)).filters[0].path).toEqual([
    { relationship_definition_id: "members", from_side: "source" },
    { relationship_definition_id: "member-org", from_side: "source" },
  ]);
  expect(errors).toEqual([]);
});

test("narrow long-name paths, columns and condition options fit their bounds", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 860 });
  await page.addInitScript(() => localStorage.setItem("fixture-long", "yes"));
  const { errors } = await fixture(page, baseURL);
  await openColumn(page, "field");
  await page.getByRole("button", { name: /^DepartmentalInterdisciplinary/ }).click();
  await selectRelated(page, "exists_related", "department_members");
  await page.getByTestId("add-report-indicator").click();
  const editor = page.getByTestId("report-indicator-conditions");
  await editor.getByTestId("add-indicator-condition").click();
  await editor.getByRole("combobox", { name: /condition 1 field/ }).click();
  await page.getByRole("option").filter({ hasText: /^Relationship: Departmental/ }).click();
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(await fits()).toBe(true);
  await editor.getByRole("button", { name: "Indicator related records", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  expect(await fits()).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("narrow-selector.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.locator('details').filter({ has: page.getByTestId("report-start-entity") }).locator("summary").click();
  await page.getByRole("combobox", { name: "Advanced starting entity", exact: true }).click();
  expect(await fits()).toBe(true);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("narrow-columns.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("legacy V1 remains opaque and unavailable V2 indicator metadata blocks execution", async ({ page, baseURL }) => {
  const legacy = { version: 1, start_object_id: "department", grain_path: [],
    columns: [{ kind: "field", path: [], field_id: "name", label: "Legacy department" }], multi_value: "join" };
  const { errors } = await fixture(page, baseURL);
  await page.evaluate((definition) => localStorage.setItem("fixture-report", JSON.stringify(definition)), legacy);
  await page.reload();
  await expect(page.getByTestId("column-heading-0")).toHaveValue("Legacy department");
  expect(await page.evaluate(() => window.fixtureConfig)).toEqual(legacy);
  await expect(page.getByTestId("report-start-entity")).toHaveCount(0);
  await openColumn(page, "field");
  await expect(page.locator('#report-column-kind option[value="exists_related"]')).toHaveCount(0);
  const indicator = { version: 2, start_object_id: "department", start_endpoint: { kind: "custom_object", customObjectId: "department" },
    grain_path: [], include_empty: false, columns: [{ kind: "exists_related",
      path: [{ relationship_definition_id: "projects", from_side: "source" }], label: "Has project",
      conditions: [{ kind: "field", field_id: "title", op: "equals", value: "Original" }] }] };
  // A fresh document with the controlled unavailable-metadata snapshot.
  await page.evaluate((definition) => {
    localStorage.setItem("fixture-report", JSON.stringify(definition));
    localStorage.setItem("fixture-metadata-error", "yes");
  }, indicator);
  await page.reload();
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeDisabled();
  await expect(page.getByText(/Waiting for authorised relationship or field metadata/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry metadata", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixtureConfig)).toEqual(indicator);
  expect(errors).toEqual([]);
});

test("preview execution failure is an error, never a False indicator", async ({ page, baseURL }) => {
  const { errors } = await fixture(page, baseURL);
  await selectRelated(page, "exists_related", "department_members");
  await page.getByTestId("add-report-indicator").click();
  await page.route("**/api/custom-objects/department/report-preview", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: '{"message":"Fixture traversal unavailable"}',
  }));
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Preview failed: Fixture traversal unavailable" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "False", exact: true })).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(errors).toEqual([]);
});
