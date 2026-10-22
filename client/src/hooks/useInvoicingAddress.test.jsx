import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.example.test/Members" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { LayoutProvider, useLayoutContext } = await import("../contexts/LayoutContext.jsx");
const { setActiveTenantId } = await import("../api/base44Client.js");
const { useInvoicingAddress } = await import("./useInvoicingAddress.js");
const { default: InvoicingAddressField, InvoicingAddressStatus } = await import("../components/InvoicingAddressField.jsx");
const { INVOICING_CORE_FIELDS } = await import("../lib/invoicingAddressFields.js");
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
const addressData = city => Object.fromEntries(INVOICING_CORE_FIELDS.map(({ fieldKey }) =>
  [fieldKey, fieldKey === "invoicing_city" ? city : null]));

test("mounted independent address drafts are tenant/session/owner scoped and failures never clear unread data", async () => {
  const originalFetch = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  let layout;
  let address;
  let props = { type: "member", id: "member-a" };
  let readFailure = false;
  let writeFailure = false;
  let delayedRead = null;
  const calls = [];
  function Probe() {
    layout = useLayoutContext();
    address = useInvoicingAddress(props.type, props.id, { isNew: !!props.isNew });
    return <>
      <InvoicingAddressStatus address={address} />
      <InvoicingAddressField address={address} fieldKey="invoicing_city" isEditing />
    </>;
  }
  const render = async () => {
    await act(async () => root.render(<QueryClientProvider client={client}><LayoutProvider><Probe /></LayoutProvider></QueryClientProvider>));
    await settle();
  };
  const authenticate = async (tenant, viewer, session) => {
    await act(async () => {
      setActiveTenantId(tenant);
      layout.setMemberInfo({ tenant_id: tenant, id: viewer, role_id: `role-${tenant}` });
      layout.setSessionRoleSnapshot({
        status: "ready", tenant_id: tenant, member_id: viewer, role_id: `role-${tenant}`, session_key: session,
        role: { id: `role-${tenant}`, tenant_id: tenant, excluded_features: [] },
      });
      layout.setAuthResolved(true);
      layout.setSessionValidated(true);
    });
    await settle();
  };
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET" && delayedRead) return delayedRead;
      if ((options.method === "GET" && readFailure) || (options.method === "PATCH" && writeFailure)) {
        return new Response(JSON.stringify({ error: "Protected address unavailable" }), { status: 503 });
      }
      if (options.method === "PATCH") {
        return new Response(JSON.stringify({ address: { ...addressData("Stored city"), ...JSON.parse(options.body).address } }));
      }
      return new Response(JSON.stringify({ address: addressData(new URL(url, "https://test").searchParams.get("ownerId")) }));
    };
    await render();
    assert.equal(calls.length, 0, "no reads before authentication");
    await authenticate("tenant-a", "viewer-a", "session-a");
    assert.equal(address.ready, true);
    assert.equal(container.querySelector("input").disabled, false);
    assert.equal(address.values.invoicing_city, "member-a");
    assert.equal(calls[0].headers.get("X-Tenant-Id"), "tenant-a");
    assert.equal(calls[0].credentials, "include");
    const initialCalls = calls.length;
    await act(async () => { await address.save(); });
    assert.equal(calls.length, initialCalls, "ordinary edits never PATCH an untouched address");

    await act(async () => address.setValue("invoicing_city", ""));
    await act(async () => { await address.save(); });
    assert.deepEqual(JSON.parse(calls.at(-1).body), {
      ownerType: "member", ownerId: "member-a", address: { invoicing_city: "" },
    }, "only explicit changes are patched, including clearing");
    assert.equal(address.values.invoicing_city, "");
    assert.equal(address.values.invoicing_country, "");

    await act(async () => address.setValue("invoicing_city", "Unsaved city"));
    writeFailure = true;
    await act(async () => { await assert.rejects(address.save(), /Protected address unavailable/); });
    assert.equal(address.values.invoicing_city, "Unsaved city");
    assert.equal(address.saveError, true);
    assert.match(container.textContent, /changes are retained.*Retry Save/);
    writeFailure = false;
    await act(async () => { await address.save(); });
    assert.equal(address.error, null);
    await act(async () => address.setValue("invoicing_city", "Cancelled city"));
    await act(async () => address.reset());
    assert.equal(address.values.invoicing_city, "Unsaved city", "cancel restores the dedicated server baseline");

    readFailure = true;
    props = { type: "organization", id: "org-b" };
    await render();
    assert.equal(address.ready, false);
    assert.match(address.error, /Protected address unavailable/);
    assert.match(container.querySelector('[role="alert"]').textContent, /Retry loading/);
    assert.equal(container.querySelector("input").disabled, true);
    assert.equal(address.values.invoicing_city, "", "member data cannot appear in an organisation draft");
    await act(async () => address.setValue("invoicing_city", "Forbidden draft"));
    const failedLoadCalls = calls.length;
    await act(async () => { await address.save(); });
    assert.equal(calls.length, failedLoadCalls, "saving non-address changes after a failed load never PATCHes empties");
    readFailure = false;
    await act(async () => { await address.retry(); });
    await settle();
    assert.equal(address.values.invoicing_city, "org-b");
    await act(async () => address.setValue("invoicing_city", "Org edit"));
    readFailure = true;
    await act(async () => { await address.retry(); });
    await settle();
    await act(async () => { await assert.rejects(address.save(), /Reload the invoicing address/); });
    assert.equal(address.values.invoicing_city, "Org edit", "failed refresh does not wipe an existing draft");
    readFailure = false;
    await act(async () => { await address.retry(); });
    await settle();
    await act(async () => { await address.save(); });
    assert.equal(JSON.parse(calls.at(-1).body).ownerType, "organization");
    assert.equal(JSON.parse(calls.at(-1).body).ownerId, "org-b");

    const oldSave = address.save;
    await authenticate("tenant-b", "viewer-b", "session-b");
    await assert.rejects(oldSave(), /tenant, session or address owner changed/);
    assert.equal(address.values.invoicing_city, "org-b", "new tenant reads its own endpoint rather than the old tenant draft");
    assert.equal(calls.at(-1).headers.get("X-Tenant-Id"), "tenant-b");

    await act(async () => address.setValue("invoicing_city", "Discard on owner change"));
    props = { type: "member", id: "another-member" };
    await render();
    props = { type: "organization", id: "org-b" };
    await render();
    assert.equal(address.values.invoicing_city, "org-b", "returning to an owner does not resurrect an abandoned draft");

    let releaseRead;
    delayedRead = new Promise(resolve => { releaseRead = resolve; });
    props = { type: "member", id: "late-member" };
    await render();
    assert.equal(address.ready, false);
    delayedRead = null;
    props = { type: "organization_group", id: "group-c" };
    await render();
    assert.equal(address.values.invoicing_city, "group-c");
    await act(async () => { releaseRead(new Response(JSON.stringify({ address: addressData("Private late member") }))); });
    await settle();
    assert.equal(address.values.invoicing_city, "group-c", "late responses cannot hydrate a different owner");

    props = { type: "organization", id: undefined, isNew: true };
    const beforeNew = calls.length;
    await render();
    assert.equal(calls.length, beforeNew, "new organisations have no address GET before creation");
    await act(async () => address.setValue("invoicing_city", "New organisation city"));
    await act(async () => { await assert.rejects(address.save(), /Create the address owner/); });
    assert.equal(calls.length, beforeNew);
    await act(async () => { await address.save("new-created-id"); });
    assert.deepEqual(JSON.parse(calls.at(-1).body), {
      ownerType: "organization", ownerId: "new-created-id", address: { invoicing_city: "New organisation city" },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setActiveTenantId(null);
    globalThis.fetch = originalFetch;
  }
});
