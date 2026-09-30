import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/OrganisationDirectorySettings",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useOrganisationDirectoryFilterSettings } = await import("./useOrganisationDirectoryFilterSettings.js");
const { default: DirectoryFilterToggle } = await import("../components/directory/DirectoryFilterToggle.jsx");
const { isOrganisationDirectoryFieldFilterable } = await import("../../../shared/organisationDirectoryFilters.js");

const response = (overrides, status = 200) => new Response(JSON.stringify({ overrides }), { status });
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

async function mount() {
  let current;
  let identity = "tenant:viewer";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Settings() {
    current = useOrganisationDirectoryFilterSettings({ enabled: true, identity });
    return <DirectoryFilterToggle
      label="Specialty"
      checked={isOrganisationDirectoryFieldFilterable("custom:specialty", current.overrides, { is_filterable: true })}
      disabled={!current.isSuccess || current.isFetching}
      onCheckedChange={value => current.setOverride("custom:specialty", value)}
    />;
  }
  const render = () => root.render(<QueryClientProvider client={client}><Settings /></QueryClientProvider>);
  await act(async () => render());
  await settle();
  return {
    container, client,
    get current() { return current; },
    async identity(value) { identity = value; await act(async () => render()); await settle(); },
    async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}

test("mounted toggle inherits legacy state, saves explicit off, and survives refetch", async () => {
  let saved = { "object-field:unavailable": true };
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      writes.push(body);
      saved = { ...saved, ...body.changes };
    }
    return response(saved);
  };
  const view = await mount();
  try {
    const toggle = view.container.querySelector('[role="switch"]');
    assert.equal(toggle.getAttribute("aria-label"), "Use Specialty as filter");
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await act(async () => view.current.refetch());
    assert.equal(toggle.getAttribute("aria-checked"), "false", "refetch must not replace manual choices");
    await act(async () => view.current.save());
    assert.deepEqual(writes, [{ changes: { "custom:specialty": false } }]);
    assert.equal(saved["object-field:unavailable"], true, "only changed keys are sent");
    await act(async () => view.current.refetch());
    await settle();
    assert.equal(toggle.getAttribute("aria-checked"), "false");
  } finally { await view.cleanup(); }
});

test("load errors disable controls and save, while retry preserves local edits", async () => {
  let failing = false;
  let writes = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === "PUT") writes++;
    if (failing) return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
    return response({});
  };
  const view = await mount();
  try {
    await act(async () => view.current.setOverride("custom:specialty", false));
    failing = true;
    await act(async () => view.current.refetch());
    await settle();
    assert.equal(view.current.isError, true);
    assert.equal(view.container.querySelector('[role="switch"]').disabled, true);
    await assert.rejects(view.current.save(), /load before saving/);
    assert.equal(writes, 0);
    assert.equal(view.current.overrides["custom:specialty"], false);
    failing = false;
    await act(async () => view.current.refetch());
    await settle();
    assert.equal(view.current.isSuccess, true);
    assert.equal(view.current.overrides["custom:specialty"], false);
  } finally { await view.cleanup(); }
});

test("edits made while a save is pending are not lost", async () => {
  let finish;
  let saved = {};
  globalThis.fetch = async (url, options) => {
    if (options.method === "PUT") {
      saved = { ...saved, ...JSON.parse(options.body).changes };
      return new Promise(resolve => { finish = () => resolve(response(saved)); });
    }
    return response(saved);
  };
  const view = await mount();
  try {
    await act(async () => view.current.setOverride("custom:specialty", false));
    let pending;
    await act(async () => { pending = view.current.save(); });
    await act(async () => view.current.setOverride("custom:specialty", true));
    await act(async () => { finish(); await pending; });
    assert.equal(view.current.overrides["custom:specialty"], true);
    assert.equal(saved["custom:specialty"], false);
  } finally { await view.cleanup(); }
});

test("unsaved choices never cross tenant/viewer identity", async () => {
  globalThis.fetch = async () => response({});
  const view = await mount();
  try {
    await act(async () => view.current.setOverride("custom:specialty", false));
    await view.identity("other-tenant:other-viewer");
    assert.equal(view.current.overrides["custom:specialty"], undefined);
    assert.equal(view.container.querySelector('[role="switch"]').getAttribute("aria-checked"), "true");
  } finally { await view.cleanup(); }
});

test("malformed response fails closed rather than replacing choices with defaults", async () => {
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const view = await mount();
  try {
    assert.equal(view.current.isError, true);
    assert.equal(view.container.querySelector('[role="switch"]').disabled, true);
    await assert.rejects(view.current.save(), /load before saving/);
  } finally { await view.cleanup(); }
});