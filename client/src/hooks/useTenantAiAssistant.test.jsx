import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.test/" });
for (const name of ["window", "document", "navigator"]) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { setActiveTenantId } = await import("../api/base44Client.js");
const { useTenantAiAssistant } = await import("./useTenantAiAssistant.js");

test("assistant config is shared, tenant/session isolated, fail closed and invalidatable", async () => {
  const originalFetch = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  let calls = 0;
  let current;
  function Probe({ memberId, memberTenantId, sessionValidated, sessionScope }) {
    const { config } = useTenantAiAssistant({ memberId, memberTenantId, sessionValidated, sessionScope });
    current = config;
    return <span>{config?.name || "hidden"}</span>;
  }
  const render = async (memberId, sessionValidated, sessionScope = "session-a", memberTenantId = "tenant-a") => {
    await act(async () => {
      root.render(<QueryClientProvider client={client}>
        <Probe memberId={memberId} memberTenantId={memberTenantId} sessionValidated={sessionValidated} sessionScope={sessionScope} />
        <Probe memberId={memberId} memberTenantId={memberTenantId} sessionValidated={sessionValidated} sessionScope={sessionScope} />
      </QueryClientProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  };
  try {
    setActiveTenantId(null); // member-only auth has no admin tenant bootstrap
    globalThis.fetch = async (_url, options) => {
      calls++;
      const tenantId = options.headers["X-Tenant-Id"];
      return { ok: true, json: async () => ({
        tenantId, enabled: true, name: `${tenantId}-${calls}`, avatarUrl: "",
        description: `${tenantId} introduction ${calls}`, backgroundColor: "", textColor: calls === 1 ? "#FFFFFF" : "", overrides: {},
      }) };
    };
    await render("member-a", false);
    assert.equal(calls, 0);
    await render("member-a", true);
    assert.equal(calls, 1, "member-only navigation and panel observers share one request");
    assert.equal(current.name, "tenant-a-1");
    assert.equal(current.description, "tenant-a introduction 1");
    assert.equal(current.textColor, "#FFFFFF");
    await render("member-b", true);
    assert.equal(current.name, "tenant-a-2");
    assert.equal(current.textColor, "");
    await render("member-b", true, "session-a", "tenant-b");
    assert.equal(current?.tenantId, "tenant-b");
    assert.equal(current.description, "tenant-b introduction 3");
    await act(async () => setActiveTenantId("tenant-a"));
    await render("member-b", true, "session-a", "tenant-b");
    assert.equal(current, null, "an admin/member tenant mismatch fails closed");
    await act(async () => setActiveTenantId(null));
    await render("member-b", true, "session-a", "tenant-b");
    assert.equal(current?.tenantId, "tenant-b");
    await render("member-b", false, "session-a", "tenant-b");
    assert.equal(current, null);
    await render("member-b", true, "session-b", "tenant-b");
    assert.equal(current.name, "tenant-b-4");
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["tenant-ai-assistant"] });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(current.name, "tenant-b-5");
    assert.equal(current.description, "tenant-b introduction 5");
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ tenantId: "other", enabled: true }) });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["tenant-ai-assistant"] });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(current, null, "a failed refresh must hide stale configuration");
    // Invalid responses never replace a verified config; a new identity fails closed.
    await render("member-c", true, "session-b", "tenant-b");
    assert.equal(current, null);
  } finally {
    await act(async () => root.unmount());
    setActiveTenantId(null);
    client.clear();
    globalThis.fetch = originalFetch;
  }
});