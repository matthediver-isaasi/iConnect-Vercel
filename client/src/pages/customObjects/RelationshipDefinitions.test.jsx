import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/CustomObjectsAdmin/object-1",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.DocumentFragment = dom.window.DocumentFragment;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
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
const { RelationshipDefinitions } = await import("./RelationshipDefinitions.jsx");

const object = {
  id: "object-1",
  status: "active",
  singular_label: "Department",
  plural_label: "Departments",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const relationshipList = (definitions) => ({
  data: definitions,
  total: definitions.length,
});

const existingDefinition = {
  id: "relationship-1",
  status: "active",
  relationship_key: "department_member",
  source_kind: "custom_object",
  source_custom_object_id: "object-1",
  target_kind: "member",
  target_custom_object_id: null,
  cardinality: "many_to_many",
  source_label: "People",
  target_label: "Department",
  is_required: false,
  show_on_source: true,
  show_on_target: true,
  edit_from_source: true,
  edit_from_target: false,
  configuration: {
    relationship_fields: [{
      id: "field-1",
      key: "is_primary",
      label: "Primary",
      type: "boolean",
      default_value: true,
      required: false,
      display_on_source: true,
      display_on_target: true,
      edit_from_source: true,
      edit_from_target: false,
    }],
  },
};

function relationshipResponses(definitions) {
  return {
    definitions: relationshipList(definitions),
    objects: { data: [object], total: 1 },
    graph: { data: [] },
    fields: { data: [], total: 0 },
  };
}

function makeFetch(definitions, requests) {
  const responses = relationshipResponses(definitions);
  return async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.includes("/relationship-definitions/relationship-1")) {
      if (options.method === "PATCH") return json({ data: existingDefinition });
      throw new Error(`Unexpected relationship detail request: ${path}`);
    }
    if (path.includes("/relationship-definition-graph")) return json(responses.graph);
    if (path.includes("/relationship-definitions")) return json(responses.definitions);
    if (path.includes("/api/custom-objects?")) return json(responses.objects);
    if (path.includes("/fields?")) return json(responses.fields);
    throw new Error(`Unexpected request: ${path}`);
  };
}

async function settle(delay = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
  });
}

async function mount(definitions, fetchImpl) {
  globalThis.fetch = fetchImpl;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RelationshipDefinitions objectId="object-1" object={object} canManage />
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

const click = (element) => element.click();

const changeText = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};

const inputByPlaceholder = (container, placeholder) =>
  container.querySelector(`input[placeholder="${placeholder}"]`);

test("empty definitions page opens a configured new dialog and creates a valid relationship", async () => {
  const requests = [];
  const view = await mount([], makeFetch([], requests));
  try {
    assert.match(view.container.textContent, /No relationships defined/);
    const firstButton = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent.includes("New relationship"));
    assert.ok(firstButton);
    await act(() => click(firstButton));
    await settle();

    assert.match(document.body.textContent, /Define a relationship/);
    assert.equal(inputByPlaceholder(document.body, "committee_membership").value, "");
    assert.match(document.body.textContent, /Departments/);
    assert.match(document.body.textContent, /No relationship fields configured/);
    const createButton = [...document.body.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Create relationship"));
    assert.equal(createButton.disabled, true);

    changeText(inputByPlaceholder(document.body, "committee_membership"), "department members");
    const panelLabels = document.body.querySelectorAll('input[placeholder="Members"], input[placeholder="Committees"]');
    changeText(panelLabels[0], "People");
    changeText(panelLabels[1], "Departments");
    await settle();
    assert.equal(createButton.disabled, false);

    await act(async () => click(createButton));
    await settle();

    const post = requests.find(({ options }) => options.method === "POST");
    assert.ok(post, "creating the relationship should issue a POST");
    assert.match(post.path, /\/api\/custom-objects\/object-1\/relationship-definitions$/);
    const body = JSON.parse(post.options.body);
    assert.equal(body.relationship_key, "department_members");
    assert.equal(body.source_label, "People");
    assert.equal(body.target_label, "Departments");
    assert.equal(document.body.querySelector('[role="dialog"]'), null);
  } finally {
    await view.cleanup();
  }
});

test("editing retains relationship fields through PATCH and a subsequent New dialog resets them", async () => {
  const requests = [];
  const view = await mount([existingDefinition], makeFetch([existingDefinition], requests));
  try {
    const editButton = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Edit"));
    assert.ok(editButton);
    await act(() => click(editButton));
    await settle();

    assert.match(document.body.textContent, /Edit relationship/);
    assert.equal(inputByPlaceholder(document.body, "committee_membership").value, "department_member");
    assert.equal(inputByPlaceholder(document.body, "is_primary").value, "is_primary");
    assert.equal(inputByPlaceholder(document.body, "Primary relationship").value, "Primary");

    const saveButton = [...document.body.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Save changes"));
    assert.equal(saveButton.disabled, false);
    await act(() => click(saveButton));
    await settle();

    const patch = requests.find(({ options }) => options.method === "PATCH");
    assert.ok(patch, "editing the relationship should issue a PATCH");
    assert.match(patch.path, /\/api\/custom-objects\/object-1\/relationship-definitions\/relationship-1$/);
    const patchBody = JSON.parse(patch.options.body);
    assert.deepEqual(patchBody.configuration.relationship_fields, [{
      id: "field-1",
      key: "is_primary",
      label: "Primary",
      type: "boolean",
      default_value: true,
      required: false,
      display_on_source: true,
      display_on_target: true,
      edit_from_source: true,
      edit_from_target: false,
    }]);
    assert.equal(document.body.querySelector('[role="dialog"]'), null);

    const newButton = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent.includes("New relationship"));
    assert.ok(newButton);
    await act(() => click(newButton));
    await settle();

    assert.match(document.body.textContent, /Define a relationship/);
    assert.equal(inputByPlaceholder(document.body, "committee_membership").value, "");
    assert.equal(document.body.querySelector('input[placeholder="is_primary"]'), null);
    assert.match(document.body.textContent, /No relationship fields configured/);
    const cancelButton = [...document.body.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Cancel"));
    await act(() => click(cancelButton));
    await settle();
  } finally {
    await view.cleanup();
  }
});