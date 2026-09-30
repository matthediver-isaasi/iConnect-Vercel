import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

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

async function mount(initialConfig, suppliedDefinitions = definitions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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
          savedReports={savedReports}
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
  await act(async () => click(view.container.querySelector("[data-testid=add-count-member-organization]")));
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