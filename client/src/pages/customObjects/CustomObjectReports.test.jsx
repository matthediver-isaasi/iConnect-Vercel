import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { register } from "node:module";

// The browser loads the real scoped stylesheet. Mounted Node tests exercise
// behavior, not CSS, and must not attempt a network or stylesheet fetch.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith("/ReportBuilder.css")) return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`, import.meta.url);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/CustomObjectsAdmin/department/reports",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.DocumentFragment = dom.window.DocumentFragment;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CustomObjectReports } = await import("./CustomObjectReports.jsx");
const { ReportRelationshipFilters } = await import("./ReportRelationshipFilters.jsx");
const { makeReportConfig } = await import("./reportHelpers.mjs");

const object = {
  id: "department",
  singular_label: "Department",
  plural_label: "Departments",
};
const definitions = [
  {
    id: "department-member",
    status: "active",
    relationship_key: "department_member",
    source_label: "Members",
    source_kind: "custom_object",
    source_custom_object_id: "department",
    target_kind: "member",
  },
  {
    id: "member-organization",
    status: "active",
    relationship_key: "member_organization",
    source_label: "Organisations",
    source_kind: "member",
    target_kind: "organization",
  },
];
const departmentMemberPath = [{
  relationship_definition_id: "department-member",
  from_side: "source",
}];
const memberOrganizationPath = [{
  relationship_definition_id: "member-organization",
  from_side: "source",
}];

const savedReports = {
  reports: [],
  activeReportId: null,
  activeReport: null,
  isSaving: false,
  setActiveReportId() {},
  async createReport(name, config) { return { id: name, name, config }; },
  async updateReport() {},
  async renameReport() {},
  async deleteReport() {},
};

async function mount(initialConfig, suppliedDefinitions = definitions, suppliedSaved = savedReports) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  // These component fixtures never contact a tenant API. Seed authorised
  // connected-object metadata explicitly, including an intentionally empty schema.
  const graph = Array.isArray(suppliedDefinitions) ? suppliedDefinitions : suppliedDefinitions?.data || [];
  graph.forEach((definition) => {
    for (const side of ["source", "target"]) {
      const id = definition[`${side}_custom_object_id`];
      if (id && id !== object.id) queryClient.setQueryData(["custom-object-report-fields", id], []);
    }
  });
  let latest;
  const onConfigChange = (value) => { latest = value; };
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CustomObjectReports
          object={object}
          fields={[{ id: "department_name", label: "Department name", is_active: true }]}
          definitions={suppliedDefinitions}
          canManage
          initialConfig={initialConfig}
          savedReports={suppliedSaved}
          onConfigChange={onConfigChange}
        />
      </QueryClientProvider>,
    );
  });
  return {
    container,
    get config() { return latest; },
    async cleanup() {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    },
  };
}

const click = (element) =>
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

const changeText = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};

const changeSelect = (select, value) => {
  select.value = value;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
};

const buttonNamed = (name) => [...document.querySelectorAll("button")].find((button) =>
  button.textContent.trim() === name || button.getAttribute("aria-label") === name);

async function chooseRelatedRecords(view, kind, steps) {
  await act(async () => click(view.container.querySelector("[data-testid=add-report-column]")));
  await act(async () => changeSelect(view.container.querySelector("[data-testid=report-column-kind]"), kind));
  await act(async () => click(buttonNamed(kind === "related_field" ? "Related records from starting entity" : "Related records from each row")));
  for (const relationship of steps) {
    await act(async () => click([...document.querySelectorAll('[role="dialog"] button')].find((button) =>
      button.textContent.includes(relationship))));
  }
  await act(async () => click([...document.querySelectorAll('[role="dialog"] button')].find((button) =>
    button.textContent.startsWith("Use "))));
}

test("V2 builder edits include-empty, row-relative count, headings and empty labels and reloads them", async () => {
  const initial = makeReportConfig("department", {
    grain_path: departmentMemberPath,
    columns: [{
      id: "department-name",
      kind: "field",
      path: [],
      field_id: "department_name",
      label: "Department",
    }],
  });
  const view = await mount(initial);

  assert.ok(view.container.querySelector("[data-testid=report-start-entity]"));
  assert.match(view.container.querySelector("[data-testid=report-row-path]").textContent, /Member/);
  await act(async () => click(view.container.querySelector("[data-testid=report-include-empty]")));
  await chooseRelatedRecords(view, "count_distinct", ["member_organization"]);
  await act(async () => click(view.container.querySelector("[data-testid=add-report-count]")));
  await act(async () => changeText(
    view.container.querySelector("[data-testid=column-heading-0]"), "Team",
  ));
  await act(async () => changeText(
    view.container.querySelector("[data-testid=column-empty-label-0]"), "No departments",
  ));

  assert.equal(view.config.include_empty, true);
  assert.equal(view.config.columns[0].label, "Team");
  assert.equal(view.config.columns[0].empty_label, "No departments");
  assert.deepEqual(view.config.columns[1], {
    id: view.config.columns[1].id,
    kind: "count_distinct",
    path: memberOrganizationPath,
    label: "Distinct Organisation count",
  });

  const savedSnapshot = JSON.parse(JSON.stringify(view.config));
  await view.cleanup();
  const reloaded = await mount(savedSnapshot);
  assert.equal(reloaded.container.querySelector("[data-testid=report-include-empty]").checked, true);
  assert.equal(reloaded.container.querySelector("[data-testid=column-heading-0]").value, "Team");
  assert.equal(
    reloaded.container.querySelector("[data-testid=column-empty-label-0]").value,
    "No departments",
  );
  assert.equal(
    reloaded.container.querySelector("[data-testid=column-heading-1]").value,
    "Distinct Organisation count",
  );
  await reloaded.cleanup();
});

test("V2 reload shows a connected starting root and grain relative to that root", async () => {
  const config = makeReportConfig("department", {
    start_endpoint: { kind: "member" },
    grain_path: memberOrganizationPath,
    columns: [{ kind: "field", path: [], field: "email", label: "Email" }],
  });
  const view = await mount(config);
  assert.match(view.container.querySelector("[data-testid=report-start-entity]").textContent, /Member/);
  assert.match(view.container.querySelector("[data-testid=report-row-path]").textContent, /Organisation/);
  assert.deepEqual(view.config.start_endpoint, { kind: "member" });
  assert.deepEqual(view.config.grain_path, memberOrganizationPath);
  await view.cleanup();
});

test("V1 reload preserves legacy controls and definition without V2 migration", async () => {
  const legacy = {
    version: 1,
    start_object_id: "department",
    grain_path: departmentMemberPath,
    columns: [{ kind: "field", path: [], field_id: "department_name", label: "Department" }],
    multi_value: "join",
  };
  const view = await mount(legacy);
  assert.deepEqual(view.config, legacy);
  assert.equal(view.container.querySelector("[data-testid=report-start-entity]"), null);
  assert.equal(view.container.querySelector("[data-testid=report-include-empty]"), null);
  assert.equal(view.container.querySelector("[data-testid=report-distinct-counts]"), null);
  assert.match(view.container.querySelector("[data-testid=report-row-path]").textContent, /Member/);
  await view.cleanup();
});

test("schema reconciliation displays stale selections without rewriting saved paths", async () => {
  const config = makeReportConfig("department", {
    grain_path: departmentMemberPath,
    columns: [{
      kind: "field",
      path: departmentMemberPath,
      field: "email",
      label: "Member email",
    }],
  });
  const view = await mount(config, []);
  assert.match(view.container.textContent, /unavailable or disconnected relationship/i);
  assert.deepEqual(view.config.grain_path, departmentMemberPath);
  assert.deepEqual(view.config.columns[0].path, departmentMemberPath);
  await view.cleanup();
});

test("starting-root control distinguishes multiple named custom objects from graph metadata", async () => {
  const customDefinitions = {
    data: [
      {
        id: "department-project",
        status: "active",
        relationship_key: "department_project",
        source_label: "Projects",
        source_kind: "custom_object",
        source_custom_object_id: "department",
        target_kind: "custom_object",
        target_custom_object_id: "project",
      },
      {
        id: "department-location",
        status: "active",
        relationship_key: "department_location",
        source_label: "Locations",
        source_kind: "custom_object",
        source_custom_object_id: "department",
        target_kind: "custom_object",
        target_custom_object_id: "location",
      },
    ],
    objects: [
      { id: "project", singular_label: "Project", plural_label: "Projects" },
      { id: "location", singular_label: "Location", plural_label: "Locations" },
    ],
  };
  const project = await mount(makeReportConfig("department", {
    start_endpoint: { kind: "custom_object", customObjectId: "project" },
  }), customDefinitions);
  assert.match(project.container.querySelector("[data-testid=report-start-entity]").textContent, /Projects/);
  await project.cleanup();

  const location = await mount(makeReportConfig("department", {
    start_endpoint: { kind: "custom_object", customObjectId: "location" },
  }), customDefinitions);
  assert.match(location.container.querySelector("[data-testid=report-start-entity]").textContent, /Locations/);
  await location.cleanup();
});

test("malformed and unsupported persisted definitions render safely, stay opaque, and cannot run", async () => {
  const cases = [
    {
      version: 2,
      start_object_id: "department",
      grain_path: [],
      columns: [],
      include_empty: false,
    },
    {
      version: 2,
      start_object_id: "department",
      start_endpoint: "member",
      grain_path: [null],
      columns: [null, { kind: "field", path: [null] }],
      include_empty: "yes",
    },
    {
      version: 2,
      start_object_id: "department",
      start_endpoint: { kind: "member" },
      grain_path: "not-a-path",
      columns: { bad: true },
      include_empty: false,
    },
    {
      version: 81,
      future_definition: { untouched: true },
    },
  ];
  for (const persisted of cases) {
    const view = await mount(persisted);
    assert.equal(view.config, persisted);
    assert.match(view.container.textContent, /malformed|invalid|unavailable|not supported/i);
    const buttons = [...view.container.querySelectorAll("button")];
    assert.equal(buttons.find((button) => button.textContent.includes("Preview")).disabled, true);
    assert.equal(buttons.find((button) => button.textContent.includes("Export CSV")).disabled, true);
    await view.cleanup();
  }
});

test("explicit Add field repairs malformed persisted columns without mutating the snapshot", async () => {
  const persisted = {
    version: 2,
    start_object_id: "department",
    start_endpoint: { kind: "custom_object", customObjectId: "department" },
    grain_path: [],
    include_empty: false,
    columns: { bad: true },
  };
  const original = JSON.parse(JSON.stringify(persisted));
  const view = await mount(persisted);
  assert.equal(view.config, persisted);
  await act(async () => click(view.container.querySelector("[data-testid=add-report-column]")));

  const addDepartmentName = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent.includes("Department name"));
  assert.ok(addDepartmentName);
  await act(async () => click(addDepartmentName));

  assert.deepEqual(persisted, original);
  assert.notEqual(view.config, persisted);
  assert.equal(Array.isArray(view.config.columns), true);
  assert.equal(view.config.columns.length, 1);
  assert.equal(view.config.columns[0].kind, "field");
  assert.equal(view.config.columns[0].field_id, "department_name");
  assert.deepEqual(view.config.columns[0].path, []);
  await view.cleanup();
});

test("relationship filters add/remove conditions, edit values, and reload opaque saved configuration", async () => {
  const initial = makeReportConfig("department", {
    filters: [{
      id: "no-responders", mode: "none", path: departmentMemberPath,
      conditions: [{ kind: "field", field: "email", op: "contains", value: "example.test" }],
    }],
  });
  const view = await mount(initial);
  assert.match(view.container.querySelector("[data-testid=report-filter-0]").textContent, /None match/);
  await act(async () => changeText(view.container.querySelector("[data-testid=filter-0-value-0]"), "literal%_"));
  assert.equal(view.config.filters[0].conditions[0].value, "literal%_");
  await act(async () => click(view.container.querySelector("[data-testid=add-filter-condition-0]")));
  assert.equal(view.config.filters[0].conditions.length, 2);
  await act(async () => click(view.container.querySelector('[aria-label="Remove filter 1 condition 2"]')));
  assert.equal(view.config.filters[0].conditions.length, 1);
  await act(async () => click(view.container.querySelector("[data-testid=add-report-filter]")));
  assert.equal(view.config.filters.length, 2);
  assert.equal(view.config.filters[1].conditions.length, 0);
  assert.match(view.container.querySelector("[data-testid=report-filter-1]").textContent, /require existence/);
  await act(async () => click(view.container.querySelector('[aria-label="Remove filter 2"]')));
  assert.equal(view.config.filters.length, 1);
  assert.equal(initial.filters[0].conditions[0].value, "example.test");
  const snapshot = JSON.parse(JSON.stringify(view.config));
  await view.cleanup();
  const reloaded = await mount(snapshot);
  assert.deepEqual(reloaded.config, snapshot);
  assert.equal(reloaded.container.querySelector("[data-testid=filter-0-value-0]").value, "literal%_");
  await reloaded.cleanup();
});

test("stale and unsupported filter selections remain visible and block execution until explicit removal", async () => {
  const schema = [{
    ...definitions[0],
    relationship_fields: [
      { id: "responder", key: "responder", label: "Responder", type: "boolean" },
      { id: "tags", key: "tags", label: "Tags", type: "picklist" },
    ],
  }];
  for (const condition of [
    { kind: "field", field: "deleted", op: "equals", value: "keep" },
    { kind: "relationship_field", relationship_field_id: "tags", op: "equals", value: "keep" },
    { kind: "relationship_field", relationship_field_id: "responder", op: "equals", value: "Yes" },
  ]) {
    const initial = makeReportConfig("department", {
      columns: [{ kind: "field", path: [], field_id: "department_name", label: "Name" }],
      filters: [{ mode: "none", path: departmentMemberPath, conditions: [condition] }],
    });
    const view = await mount(initial, schema);
    assert.equal(view.config, initial);
    assert.match(view.container.textContent, /unavailable|unsupported|boolean/i);
    assert.equal([...view.container.querySelectorAll("button")].find((button) => button.textContent === "Preview").disabled, true);
    await act(async () => click(view.container.querySelector('[aria-label="Remove filter 1 condition 1"]')));
    assert.equal(view.config.filters[0].conditions.length, 0);
    assert.equal([...view.container.querySelectorAll("button")].find((button) => button.textContent === "Preview").disabled, false);
    await view.cleanup();
  }
});

test("malformed filter arrays and conditions require explicit repair; reload never rewrites", async () => {
  for (const filters of ["invalid", [null], [{ mode: "any", path: [null], conditions: [null] }],
    [{ mode: "none", path: departmentMemberPath, conditions: "invalid" }]]) {
    const initial = makeReportConfig("department", { filters });
    const view = await mount(initial);
    assert.equal(view.config, initial);
    assert.match(view.container.textContent, /malformed|nonempty/);
    const reset = [...view.container.querySelectorAll("button")].find((button) => /Reset relationship filters|Remove malformed filter|Reset conditions/.test(button.textContent));
    if (reset) {
      await act(async () => click(reset));
      assert.notEqual(view.config, initial);
      assert.equal(initial.filters, filters);
    }
    await view.cleanup();
  }
});

test("filter and condition limits disable add actions and legacy report explains explicit new report", async () => {
  const initial = makeReportConfig("department", {
    filters: Array.from({ length: 10 }, (_, index) => ({
      id: `saved-${index}`, mode: "any", path: departmentMemberPath,
      conditions: Array.from({ length: 10 }, () => ({ kind: "field", field: "email", op: "equals", value: "" })),
    })),
  });
  const view = await mount(initial);
  assert.equal(view.container.querySelector("[data-testid=add-report-filter]").disabled, true);
  assert.equal(view.container.querySelector("[data-testid=add-filter-condition-0]").disabled, true);
  await view.cleanup();
  const legacy = { version: 1, start_object_id: "department", grain_path: [], columns: [] };
  const old = await mount(legacy);
  assert.equal(old.container.querySelector("[data-testid=report-relationship-filters]"), null);
  assert.match(old.container.textContent, /Create a new current-version report/);
  assert.equal(old.config, legacy);
  await act(async () => click([...old.container.querySelectorAll("button")].find((button) => button.textContent === "Start a new current-version report")));
  assert.equal(old.config.version, 2);
  assert.ok(old.container.querySelector("[data-testid=report-relationship-filters]"));
  assert.deepEqual(legacy, { version: 1, start_object_id: "department", grain_path: [], columns: [] });
  await old.cleanup();
});

test("pending and error field metadata preserve saved filter selections with retry and loaded stale repair", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const filters = [{ mode: "none", path: departmentMemberPath, conditions: [
    { kind: "field", field_id: "title", op: "equals", value: "Original" },
  ] }];
  const snapshot = JSON.stringify(filters);
  const graph = [{ ...definitions[0], target_kind: "custom_object", target_custom_object_id: "project" }];
  let changes = 0;
  let retries = 0;
  const props = {
    filters, onChange: () => { changes += 1; }, canManage: true,
    paths: [departmentMemberPath], start: { kind: "custom_object", customObjectId: "department" },
    definitions: graph, objects: [], object, onRetry: () => { retries += 1; },
  };
  await act(async () => root.render(<ReportRelationshipFilters {...props} fieldsByEndpoint={{}} />));
  assert.match(container.textContent, /metadata is not yet available/);
  assert.match(container.textContent, /title/);
  assert.equal(container.querySelector("[data-testid=add-filter-condition-0]").disabled, true);
  await act(async () => root.render(<ReportRelationshipFilters {...props} fieldsByEndpoint={{}} metadataError />));
  const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry metadata");
  assert.ok(retry);
  await act(async () => click(retry));
  assert.equal(retries, 1);
  await act(async () => root.render(<ReportRelationshipFilters {...props} fieldsByEndpoint={{
    "custom_object:project": [{ id: "title", label: "Project title", field_type: "text" }],
  }} />));
  assert.match(container.textContent, /Project title/);
  assert.equal(container.querySelector("[data-testid=filter-0-value-0]").value, "Original");
  await act(async () => root.render(<ReportRelationshipFilters {...props} fieldsByEndpoint={{ "custom_object:project": [] }} />));
  assert.match(container.textContent, /Unavailable or unsupported saved field.*title/);
  assert.equal(changes, 0);
  assert.equal(JSON.stringify(filters), snapshot);
  await act(async () => root.unmount());
  container.remove();
});

test("editing filters marks a saved report dirty and Update saves the current typed definition", async () => {
  const initial = makeReportConfig("department", {
    filters: [{ mode: "none", path: departmentMemberPath, conditions: [] }],
  });
  const report = { id: "departments-without-response", name: "Departments without response", config: initial };
  let updated;
  const saved = {
    ...savedReports, reports: [report], activeReportId: report.id, activeReport: report,
    async updateReport(id, config) { updated = { id, config }; },
  };
  const view = await mount(initial, definitions, saved);
  assert.doesNotMatch(view.container.textContent, /Modified/);
  await act(async () => click(view.container.querySelector("[data-testid=add-filter-condition-0]")));
  assert.match(view.container.textContent, /Modified/);
  const trigger = view.container.querySelector("[data-testid=button-custom-object-report-switcher]");
  await act(async () => trigger.dispatchEvent(new window.MouseEvent("pointerdown", {
    bubbles: true, cancelable: true, button: 0, ctrlKey: false,
  })));
  const update = document.querySelector("[data-testid=menuitem-custom-object-report-update]");
  assert.ok(update);
  await act(async () => click(update));
  assert.equal(updated.id, report.id);
  assert.deepEqual(updated.config.filters, view.config.filters);
  assert.equal(updated.config.filters[0].conditions[0].value, "");
  assert.deepEqual(initial.filters[0].conditions, []);
  await view.cleanup();
});

test("guided indicator creation reuses conditions without mode and preserves fields, counts and rows on reload", async () => {
  const initial = makeReportConfig("department", {
    columns: [
      { id: "name", kind: "field", path: [], field_id: "department_name", label: "Department" },
      { id: "count", kind: "count_distinct", path: departmentMemberPath, label: "Members" },
    ],
  });
  const view = await mount(initial);
  await chooseRelatedRecords(view, "exists_related", ["department_member"]);
  await act(async () => click(view.container.querySelector("[data-testid=add-report-indicator]")));
  assert.equal(view.config.columns[2].kind, "exists_related");
  assert.equal(Object.hasOwn(view.config.columns[2], "mode"), false);
  assert.equal(view.container.querySelector('[data-testid=column-empty-label-2]'), null);
  const editor = view.container.querySelector("[data-testid=report-indicator-conditions]");
  assert.equal(editor.querySelector('[aria-label$="match mode"]'), null);
  await act(async () => click(editor.querySelector("[data-testid=add-indicator-condition]")));
  const value = editor.querySelector('[aria-label="Indicator column 3 condition 1 value"]');
  await act(async () => changeText(value, "literal%_"));
  assert.equal(view.config.columns[2].conditions[0].value, "literal%_");
  await act(async () => changeText(view.container.querySelector("[data-testid=column-heading-2]"), "Has survey responder"));
  assert.deepEqual(view.config.columns.slice(0, 2), initial.columns);
  assert.deepEqual(view.config.grain_path, []);
  assert.equal(Object.hasOwn(view.config, "filters"), false);
  const snapshot = JSON.parse(JSON.stringify(view.config));
  await view.cleanup();
  const reloaded = await mount(snapshot);
  assert.deepEqual(reloaded.config, snapshot);
  assert.match(reloaded.container.textContent, /True \/ False/);
  await act(async () => click(reloaded.container.querySelector('[aria-label="Move column 3 up"]')));
  assert.equal(reloaded.config.columns[1].kind, "exists_related");
  await act(async () => click(reloaded.container.querySelector('[aria-label="Remove column 2"]')));
  assert.deepEqual(reloaded.config.columns, initial.columns);
  await reloaded.cleanup();
});

test("unavailable saved indicator metadata blocks execution and is preserved until explicit repair", async () => {
  for (const suppliedGraph of [undefined, []]) {
    const initial = makeReportConfig("department", {
      columns: [{ kind: "exists_related", path: departmentMemberPath, label: "Responder", conditions: [
        { kind: "relationship_field", relationship_field_id: "missing", op: "equals", value: true },
      ] }],
    });
    // Pass null explicitly: undefined uses mount's fixture default.
    const view = await mount(initial, suppliedGraph === undefined ? null : suppliedGraph);
    assert.equal(view.config, initial);
    assert.equal(buttonNamed("Preview").disabled, true);
    assert.equal(buttonNamed("Export CSV").disabled, true);
    assert.match(view.container.textContent, /preserved|unavailable/i);
    await view.cleanup();
  }
});