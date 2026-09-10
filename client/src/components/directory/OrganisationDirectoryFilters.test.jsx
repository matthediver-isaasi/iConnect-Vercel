import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/OrganisationDirectory",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act, useEffect, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { LayoutProvider, useLayoutContext } = await import("../../contexts/LayoutContext.jsx");
const OrganisationDirectoryFilters = (await import("./OrganisationDirectoryFilters.jsx")).default;
const {
  useAuthoritativeDirectoryFilters,
  useOrganisationDirectoryMetadata,
  useOrganisationDirectoryResults,
} = await import("../../hooks/useOrganisationDirectory.js");

async function settle(delay = 20) {
  await act(async () => new Promise(resolve => setTimeout(resolve, delay)));
}

async function waitForText(container, text) {
  for (let attempt = 0; attempt < 40 && container.textContent !== text; attempt += 1) {
    await settle(25);
  }
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (condition()) return;
    await settle(25);
  }
  assert.fail("Timed out waiting for mounted view");
}

async function mount(child) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(child));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const fields = [
  { key: "status", label: "Status", control: "choice", field_type: "dropdown", multi_select: false, options: [{ value: "active", label: "Active" }] },
  { key: "score", label: "Score", control: "number", field_type: "number", multi_select: false, options: [] },
  { key: "notes", label: "Notes", control: "text", field_type: "text", multi_select: false, options: [] },
  { key: "website", label: "Website", control: "presence", field_type: "url", multi_select: false, options: [] },
  { key: "founded", label: "Founded", control: "date", field_type: "date", multi_select: false, options: [] },
];

function FilterHarness() {
  const [value, setValue] = useState({});
  return <>
    <OrganisationDirectoryFilters fields={fields} filters={value} onChange={setValue} onClear={() => setValue({})} />
    <output>{JSON.stringify(value)}</output>
  </>;
}

test("mounted controls emit the API operator/value shape and clear all", async () => {
  const view = await mount(<FilterHarness />);
  const status = view.container.querySelector('select[aria-label="Status"]');
  await act(async () => {
    status.value = "active";
    status.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.match(view.container.querySelector("output").textContent, /"status":\{"operator":"eq","value":\["active"\]\}/);

  const presence = view.container.querySelector('select[aria-label="Website"]');
  await act(async () => {
    presence.value = "absent";
    presence.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.match(view.container.querySelector("output").textContent, /"operator":"absent"/);
  const clear = [...view.container.querySelectorAll("button")].find(button => button.textContent.includes("Clear all"));
  await act(async () => clear.click());
  assert.equal(view.container.querySelector("output").textContent, "{}");
  await view.cleanup();
});

test("mounted text input is debounced before changing server filters", async () => {
  const view = await mount(<FilterHarness />);
  const input = view.container.querySelector('input[aria-label="Notes"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "careers");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(view.container.querySelector("output").textContent, "{}");
  await settle(330);
  assert.match(view.container.querySelector("output").textContent, /"notes":\{"operator":"contains","value":"careers"\}/);
  await view.cleanup();
});

test("clear all cancels pending text debounce and resets its draft", async () => {
  const view = await mount(<FilterHarness />);
  await changeNative(view.container.querySelector('select[aria-label="Status"]'), "active");
  await changeNative(view.container.querySelector('input[aria-label="Notes"]'), "pending text");
  const clear = [...view.container.querySelectorAll("button")]
    .find(button => button.textContent.includes("Clear all"));
  await act(async () => clear.click());
  assert.equal(view.container.querySelector("output").textContent, "{}");
  assert.equal(view.container.querySelector('input[aria-label="Notes"]').value, "");
  await settle(350);
  assert.equal(view.container.querySelector("output").textContent, "{}");
  assert.equal(view.container.querySelector('input[aria-label="Notes"]').value, "");
  await view.cleanup();
});

async function changeNative(element, value) {
  await act(async () => {
    const prototype = element instanceof window.HTMLInputElement
      ? window.HTMLInputElement.prototype
      : window.HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event(element instanceof window.HTMLInputElement ? "input" : "change", { bubbles: true }));
  });
}

test("between filters keep partial number and date drafts out of API state", async () => {
  const view = await mount(<FilterHarness />);
  const scoreOperator = view.container.querySelector('select[aria-label="Score operator"]');
  await changeNative(scoreOperator, "between");
  const scoreMin = view.container.querySelector('input[aria-label="Score"]');
  const scoreMax = view.container.querySelector('input[aria-label="Score maximum"]');
  await changeNative(scoreMin, "0");
  assert.doesNotMatch(view.container.querySelector("output").textContent, /score/);
  await changeNative(scoreMax, "10");
  assert.match(view.container.querySelector("output").textContent, /"score":\{"operator":"between","value":\["0","10"\]\}/);
  await changeNative(scoreMin, "20");
  assert.doesNotMatch(view.container.querySelector("output").textContent, /score/);
  assert.match(view.container.textContent, /Minimum must not exceed maximum/);

  await changeNative(view.container.querySelector('select[aria-label="Founded operator"]'), "between");
  await changeNative(view.container.querySelector('input[aria-label="Founded"]'), "2025-01-01");
  assert.doesNotMatch(view.container.querySelector("output").textContent, /founded/);
  await changeNative(view.container.querySelector('input[aria-label="Founded maximum"]'), "2025-12-31");
  assert.match(view.container.querySelector("output").textContent, /"founded":\{"operator":"between","value":\["2025-01-01","2025-12-31"\]\}/);
  await view.cleanup();
});

function AuthorityProbe() {
  const [postVersion, setPostVersion] = useState(1);
  const [filters, setFilters] = useState({
    status: { operator: "eq", value: ["active"] },
    revoked: { operator: "contains", value: "private" },
  });
  const metadata = {
    isSuccess: true,
    dataUpdatedAt: 1,
    data: { fields: [{ key: "status", label: "Old status" }, { key: "revoked", label: "Private" }] },
  };
  const results = {
    isSuccess: true,
    dataUpdatedAt: postVersion,
    data: {
      fields: postVersion === 1
        ? metadata.data.fields
        : [{ key: "status", label: "Current status" }],
    },
  };
  const authoritative = useAuthoritativeDirectoryFilters(metadata, results, setFilters);
  return <div>
    <span data-fields={authoritative.map(field => field.label).join(",")} />
    <output>{JSON.stringify(filters)}</output>
    <button onClick={() => setPostVersion(2)}>Complete newer POST</button>
  </div>;
}

test("a newer successful POST replaces cached GET fields and clears revoked selections", async () => {
  const view = await mount(<AuthorityProbe />);
  assert.match(view.container.querySelector("output").textContent, /revoked/);
  await act(async () => view.container.querySelector("button").click());
  assert.equal(view.container.querySelector("[data-fields]").getAttribute("data-fields"), "Current status");
  assert.doesNotMatch(view.container.querySelector("output").textContent, /revoked/);
  await view.cleanup();
});

function Identity({ children }) {
  const context = useLayoutContext();
  useEffect(() => {
    context.setMemberInfo({ id: "member-1", tenant_id: "tenant-1" });
    context.setSessionValidated(true);
    context.setAuthResolved(true);
  }, []);
  return children;
}

function DirectoryProbe() {
  const metadata = useOrganisationDirectoryMetadata();
  const result = useOrganisationDirectoryResults({
    filters: { status: { operator: "eq", value: ["active"] } },
    search: "uni",
    sort: "desc",
    page: 2,
    pageSize: 12,
  }, metadata.isSuccess);
  return <div>{metadata.isSuccess && result.isSuccess ? result.data.organizations[0].name : "Loading"}</div>;
}

test("mounted authenticated hooks GET metadata then POST the complete stable request", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!options.method) {
      return new Response(JSON.stringify({ fields: [fields[0]] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      organizations: [{ id: "org-1", name: "University" }],
      total: 1,
      page: 2,
      pageSize: 12,
      fields: [fields[0]],
    }), { status: 200 });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await mount(
    <QueryClientProvider client={client}>
      <LayoutProvider><Identity><DirectoryProbe /></Identity></LayoutProvider>
    </QueryClientProvider>,
  );
  await waitForText(view.container, "University");
  assert.equal(view.container.textContent, "University");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/organisation-directory/filters");
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    filters: { status: { operator: "eq", value: ["active"] } },
    search: "uni",
    sort: "desc",
    page: 2,
    pageSize: 12,
  });
  await view.cleanup();
  client.clear();
});

function SourceChoiceHarness({ initial = {}, multiSelect = true }) {
  const [value, setValue] = useState(initial);
  const sourceField = {
    key: "sector",
    label: "Sector",
    control: "source-choice",
    field_type: "text",
    multi_select: multiSelect,
    options: [],
  };
  return <>
    <OrganisationDirectoryFilters
      fields={[sourceField]}
      filters={value}
      onChange={setValue}
      onClear={() => setValue({})}
    />
    <output>{JSON.stringify(value)}</output>
  </>;
}

function withAuthenticatedQueryClient(client, child) {
  return (
    <QueryClientProvider client={client}>
      <LayoutProvider><Identity>{child}</Identity></LayoutProvider>
    </QueryClientProvider>
  );
}

test("mounted source choices search and page without clearing multi-selections during refresh", async () => {
  const calls = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const optionsForPage = body.search
      ? [{ value: "searched", label: "Searched sector" }]
      : body.page === 2
        ? [{ value: "second", label: "Second page sector" }]
        : [{ value: "first", label: "First sector" }];
    return new Response(JSON.stringify({
      options: optionsForPage,
      total: body.search ? 1 : 51,
      page: body.page,
      pageSize: 50,
      selectedOptions: body.selected.includes("first")
        ? [{ value: "first", label: "First sector" }]
        : [],
      unavailableSelected: [],
    }), { status: 200 });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await mount(withAuthenticatedQueryClient(client, <SourceChoiceHarness />));
  await waitFor(() => view.container.textContent.includes("First sector"));

  await act(async () => view.container.querySelector('input[type="checkbox"]').click());
  await waitFor(() => view.container.querySelector("output").textContent.includes('"value":["first"]'));
  await waitFor(() => view.container.textContent.includes("First sector ×"));
  assert.match(view.container.textContent, /First sector ×/);

  const refresh = [...view.container.querySelectorAll("button")].find(button => button.textContent === "Refresh");
  await act(async () => refresh.click());
  assert.match(view.container.querySelector("output").textContent, /"first"/);
  await waitFor(() => !refresh.disabled);

  const next = [...view.container.querySelectorAll("button")].find(button => button.textContent === "Next");
  await act(async () => next.click());
  await waitFor(() => view.container.textContent.includes("Second page sector"));
  assert.equal(calls.at(-1).page, 2);
  assert.deepEqual(calls.at(-1).selected, ["first"]);

  await changeNative(view.container.querySelector('input[aria-label="Search Sector options"]'), "health");
  await settle(330);
  await waitFor(() => view.container.textContent.includes("Searched sector"));
  assert.equal(calls.at(-1).search, "health");
  assert.equal(calls.at(-1).page, 1);
  assert.match(view.container.querySelector("output").textContent, /"first"/);

  const clear = [...view.container.querySelectorAll("button")].find(button => button.textContent === "Clear Sector");
  await act(async () => clear.click());
  assert.equal(view.container.querySelector("output").textContent, "{}");
  await view.cleanup();
  client.clear();
});

test("mounted source choices show failure retry and removable unavailable selections without exposing their value", async () => {
  let attempts = 0;
  globalThis.fetch = async (_url, options = {}) => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: "Options service unavailable" }), { status: 503 });
    }
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({
      options: [],
      total: 0,
      page: 1,
      pageSize: 50,
      selectedOptions: [],
      unavailableSelected: body.selected,
    }), { status: 200 });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const initial = { sector: { operator: "eq", value: ["revoked-private-value"] } };
  const view = await mount(withAuthenticatedQueryClient(client, <SourceChoiceHarness initial={initial} />));
  await waitFor(() => view.container.textContent.includes("Options service unavailable"));
  assert.match(view.container.textContent, /Retry/);
  await act(async () => [...view.container.querySelectorAll("button")].find(button => button.textContent === "Retry").click());
  await waitFor(() => view.container.textContent.includes("no longer available"));
  assert.doesNotMatch(
    view.container.querySelector('[data-testid="filter-sector"]').textContent,
    /revoked-private-value/,
  );

  const remove = view.container.querySelector('button[aria-label="Remove unavailable selection 1"]');
  await act(async () => remove.click());
  assert.equal(view.container.querySelector("output").textContent, "{}");
  await view.cleanup();
  client.clear();
});

test("mounted single source choice replaces rather than appends values", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }],
    total: 2,
    page: 1,
    pageSize: 50,
    selectedOptions: [],
    unavailableSelected: [],
  }), { status: 200 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await mount(withAuthenticatedQueryClient(client, <SourceChoiceHarness multiSelect={false} />));
  await waitFor(() => view.container.querySelectorAll('input[type="radio"]').length === 2);
  const radios = view.container.querySelectorAll('input[type="radio"]');
  await act(async () => radios[0].click());
  await act(async () => radios[1].click());
  assert.match(view.container.querySelector("output").textContent, /"value":\["two"\]/);
  assert.doesNotMatch(view.container.querySelector("output").textContent, /"one"/);
  await view.cleanup();
  client.clear();
});