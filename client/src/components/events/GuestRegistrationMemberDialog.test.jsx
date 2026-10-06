import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.example.test/report" });
for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLInputElement", "Element", "DocumentFragment", "Event", "CustomEvent", "MouseEvent", "NodeFilter", "MutationObserver"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.Node = dom.window.Node;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = (await import("react")).default;
const React = globalThis.React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { default: GuestRegistrationMemberDialog } = await import("./GuestRegistrationMemberDialog.jsx");

const payload = {
  registration: { bookingId: "booking-a", isComplex: true, eventTitle: "Annual Assembly", ticketName: "Day delegate", first_name: "Ari", last_name: "Lee", email: "ari@example.test", supplied_organization_name: "Guest Company", member_id: null },
  roles: [{ id: "role-a", name: "Event member" }],
  organisations: [{ id: "org-a", name: "Tenant Company" }],
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const settle = (ms = 25) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
const click = async node => act(async () => node.click());
async function input(id, value) {
  await act(async () => {
    const node = document.getElementById(id);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function chooseRole() {
  await act(async () => document.getElementById("guest-member-role").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await settle();
  await click(document.querySelector('[role="option"]'));
}
async function submit() {
  await act(async () => document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
}
async function mount(onSuccess = () => {}) {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><GuestRegistrationMemberDialog bookingId="booking-a" isComplex tenantId="tenant-a" viewerId="admin-a" onClose={() => {}} onSuccess={onSuccess} /></MemoryRouter></QueryClientProvider>));
  await settle();
  return async () => {
    await act(async () => root.unmount());
    client.clear();
    node.remove();
  };
}

test("loads authoritative details, requires explicit role, submits edits without auto-linking typed organisation", async () => {
  const calls = [];
  let result;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return json(options.method === "POST" ? { member: { id: "member-a" }, alreadyLinked: false } : payload);
  };
  const cleanup = await mount(data => { result = data; });
  try {
    assert.match(calls[0].url, /bookingId=booking-a&isComplex=true/);
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(document.getElementById("guest-member-first_name").value, "Ari");
    assert.match(document.body.textContent, /Guest-entered organisation \(reference\).*Guest Company/);
    assert.ok(button("Create Member").disabled);
    await submit();
    assert.equal(calls.filter(call => call.options.method === "POST").length, 0);
    await input("guest-member-first_name", "Amended");
    await input("guest-member-supplied_organization_name", "Reviewed company");
    await input("guest-member-org-search", "Tenant");
    await settle(350);
    assert.match(calls.at(-1).url, /organisationSearch=Tenant/);
    await chooseRole();
    await submit();
    await settle();
    const body = JSON.parse(calls.find(call => call.options.method === "POST").options.body);
    assert.deepEqual(body, { bookingId: "booking-a", isComplex: true, first_name: "Amended", last_name: "Lee", email: "ari@example.test", supplied_organization_name: "Reviewed company", organization_id: null, role_id: "role-a" });
    assert.equal(result.member.id, "member-a");
    assert.match(document.body.textContent, /no email will be sent/);
  } finally { await cleanup(); }
});

test("explicit organisation selection, duplicate-email errors and synchronous double-submit protection", async () => {
  let postCount = 0;
  let finish;
  let body;
  globalThis.fetch = async (_url, options) => {
    if (options.method !== "POST") return json(payload);
    postCount++;
    body = JSON.parse(options.body);
    return new Promise(resolve => { finish = () => resolve(json({ error: "A member already uses this email" }, 409)); });
  };
  const cleanup = await mount();
  try {
    await click(button("Tenant Company"));
    await chooseRole();
    await act(async () => {
      const form = document.querySelector("form");
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(postCount, 1);
    assert.equal(body.organization_id, "org-a");
    assert.ok(button("Creating member…").disabled);
    await act(async () => finish());
    await settle();
    assert.match(document.querySelector('[role="alert"]').textContent, /already uses this email/);
    assert.equal(document.getElementById("guest-member-email").value, payload.registration.email);
    assert.equal(button("Create Member").disabled, false);
    await click(button("Clear selection"));
    assert.doesNotMatch(document.body.textContent, /Selected: Tenant Company/);
  } finally { await cleanup(); }
});

test("authoritatively linked registrations show profile instead of create form", async () => {
  let result;
  globalThis.fetch = async () => json({ ...payload, registration: { ...payload.registration, member_id: "member-existing" } });
  const cleanup = await mount(data => { result = data; });
  try {
    assert.equal(document.querySelector("form"), null);
    assert.equal(document.querySelector("a").getAttribute("href"), "/members/member-existing");
    await click(button("Update report and close"));
    assert.deepEqual(result, { member: { id: "member-existing" }, alreadyLinked: true });
  } finally { await cleanup(); }
});

test("failed authoritative load offers retry and no create action", async () => {
  let failure = true;
  globalThis.fetch = async () => failure ? json({ error: "Permission denied" }, 403) : json({ ...payload, roles: [] });
  const cleanup = await mount();
  try {
    assert.match(document.querySelector('[role="alert"]').textContent, /Permission denied/);
    assert.equal(button("Create Member"), undefined);
    failure = false;
    await click(button("Retry loading details"));
    await settle();
    assert.match(document.body.textContent, /No tenant roles are available/);
    assert.ok(button("Create Member").disabled);
  } finally { await cleanup(); }
});

test("loading is announced and late authoritative responses cannot expose a closed form", async () => {
  let finish;
  globalThis.fetch = async () => new Promise(resolve => { finish = () => resolve(json(payload)); });
  const cleanup = await mount();
  assert.match(document.querySelector('[role="status"]').textContent, /Loading authoritative/);
  assert.equal(document.querySelector("form"), null);
  await cleanup();
  await act(async () => finish());
  await settle();
  assert.equal(document.querySelector("form"), null);
});

test("organisation search failures allow retry without losing reviewed names or selecting results", async () => {
  let failure = true;
  let submitted;
  globalThis.fetch = async (url, options) => {
    if (options.method === "POST") {
      submitted = JSON.parse(options.body);
      return json({ member: { id: "member-a" }, alreadyLinked: false });
    }
    if (url.includes("organisationSearch=")) return failure ? json({ error: "Search temporarily unavailable" }, 503) : json(payload);
    return json(payload);
  };
  const cleanup = await mount();
  try {
    await input("guest-member-first_name", "Reviewed Ari");
    await input("guest-member-org-search", "Company");
    await settle(350);
    await settle();
    assert.match(document.body.textContent, /Search temporarily unavailable/);
    failure = false;
    await click(button("Retry search"));
    await settle();
    assert.equal(document.getElementById("guest-member-first_name").value, "Reviewed Ari");
    assert.ok(button("Tenant Company"));
    assert.doesNotMatch(document.body.textContent, /Selected:/);
    await chooseRole();
    await submit();
    await settle();
    assert.equal(submitted.organization_id, null);
    assert.equal(submitted.first_name, "Reviewed Ari");
  } finally { await cleanup(); }
});

test("roles requiring an effective date have no assumed date and send the explicit choice", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === "POST") {
      bodies.push(JSON.parse(options.body));
      return json({ member: { id: "member-dated" }, alreadyLinked: false });
    }
    return json({ ...payload, roles: [{ id: "role-a", name: "Dated role", requires_effective_from_date: true, max_members: 3 }] });
  };
  const cleanup = await mount();
  try {
    await chooseRole();
    const date = document.getElementById("guest-member-role-effective-from");
    assert.equal(date.value, "");
    assert.equal(date.required, true);
    await submit();
    assert.equal(bodies.length, 0);
    assert.match(document.querySelector('[role="alert"]').textContent, /effective from date is required/);
    await input("guest-member-role-effective-from", "2026-04-17");
    await submit();
    await settle();
    assert.equal(bodies[0].role_effective_from, "2026-04-17");
  } finally { await cleanup(); }
});

test("report preserves permission gating, linked-member precedence, actions header and booking-only member patch", () => {
  const source = readFileSync(new URL("../../pages/EventRegistrationReport.jsx", import.meta.url), "utf8");
  assert.match(source, /isAccessReady && isAdmin && !isFeatureExcluded\("admin.role-management"\)/);
  assert.match(source, /attendee\.member_id \? \([\s\S]*canCreateGuestMember && \(attendee\.is_guest_booking \|\| !attendee\.organization_id\)/);
  assert.match(source, /<th scope="col"[^>]*>Actions<\/th>/);
  assert.match(source, /\{ \.\.\.attendee, member_id: data\.member\.id \}/);
  assert.match(source, /cancelQueries\(\{ queryKey: \["event-registration-report"\] \}\)/);
  assert.match(source, /invalidateQueries\(\{ queryKey: \["event-registration-report"\] \}\)/);
  assert.doesNotMatch(source, /is_guest_booking: false/);
  assert.match(source, /isComplex: group\.bookingSource === "complex_event_booking"/);
});
