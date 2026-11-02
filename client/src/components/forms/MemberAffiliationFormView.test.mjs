import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://isolated.example.test/FormView?slug=renew", pretendToBeVisual: true,
});
const { window } = dom;
for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "location", "history",
  "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "DocumentFragment", "MutationObserver", "Text"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] });
}
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};
window.localStorage.setItem("tenant_slug", "isolated");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
// Real page, renderer, membership-payment controls, prefill hooks and transport.
// Only HTTP and data-client results are replaced; no tenant service is called.
const bundle = await build({
  stdin: { contents: [
    "export {default as FormView} from './client/src/pages/FormView.jsx';",
    "export {default as LayoutContext} from './client/src/contexts/LayoutContext.jsx';",
    "export {publicClient} from './client/src/api/publicClient.js';",
    "export {base44,setActiveTenantId} from './client/src/api/base44Client.js';",
    "export {MemoryRouter} from 'react-router-dom';",
    "export {QueryClient,QueryClientProvider} from '@tanstack/react-query';",
  ].join("\n"), resolveDir: process.cwd(), loader: "js" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", logLevel: "silent",
  plugins: [{ name: "ignore-css", setup(builder) {
    builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: "css" }));
    builder.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
  } }],
});
const mod = new Module(`${process.cwd()}/affiliation-formview-test.cjs`);
mod.filename = `${process.cwd()}/affiliation-formview-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const { FormView, LayoutContext, publicClient, base44, setActiveTenantId,
  MemoryRouter, QueryClient, QueryClientProvider } = mod.exports;
const h = React.createElement;
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const formId = "b7019952-b991-4f60-8caf-b71efdbfe661";
const member = { id: "own-member", tenant_id: "isolated-tenant", role_id: "member-role", first_name: "Legacy prefill" };
const context = {
  authResolved: true, sessionValidated: true, memberInfo: member, organizationInfo: null,
  sessionRoleSnapshot: { member_id: member.id, tenant_id: member.tenant_id, role_id: member.role_id,
    session_key: "session-a", status: "ready", role: { id: member.role_id, excluded_features: [] } },
  setForceBlankLayout() {}, setMemberInfo() {}, setOrganizationInfo() {}, retrySessionRole() {},
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 18)); }); }
async function until(check) {
  for (let i = 0; i < 60 && !check(); i++) await settle();
  assert.ok(check(), "expected the page to settle");
}
const definition = (enabled = true, layout = "standard") => ({
  id: formId, slug: "renew", name: "Membership renewal", is_active: true,
  member_affiliation_enabled: enabled,
  require_authentication: true, mutation_access_policy: { mode: "authenticated_owner" },
  submit_button_text: "Submit", layout_type: layout, prefill_source: "none",
  allow_save_continue_later: false, entity_pipelines: {}, fields: [
    { id: "affiliation", type: "text", label: "Affiliation", default_value: "Default affiliation" },
  ],
});
const snapshot = () => ({ active: true, snapshotToken: "f733ce6e-d94a-4e63-885a-07995ceda685",
  values: { affiliation: "Current affiliation" }, managedFieldIds: ["affiliation"] });
async function mount(t, { form = definition(), snapshotRequest = async () => json(snapshot()),
  submit = async () => ({ success: true, id: "saved-submission", member_affiliations: { status: "applied" } }),
  draft, search = "", prefillRequest = async () => ({ values: {} }) } = {}) {
  setActiveTenantId(null);
  window.history.replaceState({}, "", `/FormView?slug=renew${search}`);
  const calls = [], submissions = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === "/api/auth/me") return json(member);
    if (String(url).startsWith("/api/forms/member-affiliations?")) return snapshotRequest(url, options);
    if (String(url).startsWith("/api/membership/member-amendments?")) return json({ available: false });
    if (String(url).startsWith("/api/membership/payment-plan?")) return json({ currentPlan: null });
    if (String(url).startsWith("/api/forms/membership-payment?")) return json({
      membershipYear: "2027", finalCost: 120, totalWithVat: 120, currency: "GBP",
      stripeEnabled: true, stripePublishableKey: "pk_test_fixture",
      renewal: { state: "eligible_renewal", eligible: true },
    });
    if (url === "/api/forms/membership-payment" && options.method === "POST") {
      return json({ error: "Stopped before contacting payment provider" }, 409);
    }
    if (url === "/api/forms/send-submission-email") return json({ success: true });
    assert.fail(`Unexpected network request: ${url}`);
  };
  publicClient.getForm = async () => form;
  publicClient.getFormConsentMessage = async () => ({ message: "" });
  publicClient.getFormDraft = async () => draft?.promise;
  publicClient.getFormFieldPrefill = prefillRequest;
  publicClient.listFormOrganizationOptions = async () => [{ id: "source-org", name: "Source organisation" }];
  publicClient.submitForm = async payload => { submissions.push(payload); return submit(payload, submissions.length); };
  base44.entities.MemberPreferenceValue.list = async () => [];
  base44.entities.MemberResourceCategory.list = async () => [];
  base44.entities.Member.get = async () => member;
  base44.entities.Form.update = async () => form;
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 },
  } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = async () => {
    await act(async () => root.render(h(QueryClientProvider, { client },
      h(LayoutContext.Provider, { value: context }, h(MemoryRouter,
        { initialEntries: [`/FormView?slug=renew${search}`] }, h(FormView, { slug: "renew" }))))));
    await settle();
  };
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await render();
  return { container, calls, submissions, render };
}
const button = (host, label) => [...host.querySelectorAll("button")].find(item => item.textContent === label);
const input = host => host.querySelector('input[type="text"]');
async function click(element) { assert.ok(element); await act(async () => element.click()); await settle(); }
async function edit(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
}

for (const layout of ["standard", "card_swipe"]) {
  test(`${layout}: false marker keeps ordinary submission and makes no snapshot request`, async t => {
    const view = await mount(t, { form: definition(false, layout), submit: async () => ({ id: "ordinary-submission" }) });
    await until(() => !view.container.querySelector("[data-testid=form-prefill-overlay]"));
    await click(button(view.container, "Submit"));
    await until(() => view.container.textContent.includes("Success!"));
    assert.equal(view.submissions.length, 1);
    assert.ok(view.submissions[0].idempotency_key.length >= 8);
    assert.equal(view.submissions[0].submission_data.__member_affiliation_snapshot, undefined);
    assert.equal(view.calls.filter(call => call.url.includes("/member-affiliations?")).length, 0);
  });

  test(`${layout}: snapshot blocks interaction, preserves edits/errors and retries with the same key`, async t => {
    const pending = deferred();
    const view = await mount(t, {
      form: definition(true, layout), snapshotRequest: () => pending.promise,
      submit: async (_, attempt) => attempt === 1 ? { id: "not-confirmed" }
        : { id: "saved", member_affiliations: { status: "awaiting_review" } },
    });
    await until(() => !!view.container.querySelector("[data-testid=form-prefill-overlay]"));
    await click(button(view.container, "Submit"));
    assert.equal(view.submissions.length, 0);
    const call = view.calls.find(call => call.url.includes("/member-affiliations?"));
    assert.ok(call);
    assert.equal(new URL(call.url, window.location.origin).searchParams.get("form_id"), formId);
    assert.equal(new URL(call.url, window.location.origin).searchParams.has("memberId"), false);
    assert.equal(call.options.credentials, "include");
    await act(async () => pending.resolve(json(snapshot())));
    await until(() => !view.container.querySelector("[data-testid=form-prefill-overlay]"));
    assert.equal(input(view.container).value, "Current affiliation");
    await edit(input(view.container), "Member edited affiliation");
    await view.render();
    assert.equal(input(view.container).value, "Member edited affiliation");
    await click(button(view.container, "Submit"));
    await until(() => view.container.textContent.includes("has not been confirmed"));
    assert.equal(input(view.container).value, "Member edited affiliation");
    await click(button(view.container, "Submit"));
    await until(() => view.container.textContent.includes("saved for review"));
    assert.equal(view.submissions[0].idempotency_key, view.submissions[1].idempotency_key);
    assert.ok(view.submissions[0].idempotency_key.length >= 8);
    assert.equal(view.submissions[1].submission_data.affiliation, "Member edited affiliation");
    assert.equal(view.submissions[1].submission_data.__member_affiliation_snapshot, snapshot().snapshotToken);
    assert.equal(view.calls.filter(call => call.url.includes("/member-affiliations?")).length, 1);
    assert.equal(view.calls.filter(call => call.url.includes("process-field-mappings")).length, 0);
  });
}

test("snapshot failure locks the real form and Retry restores access", async t => {
  let attempts = 0;
  const view = await mount(t, { snapshotRequest: async () => ++attempts === 1
    ? json({ error: "Affiliations unavailable" }, 503) : json(snapshot()) });
  await until(() => view.container.textContent.includes("Affiliations unavailable"));
  await click(button(view.container, "Submit"));
  assert.equal(view.submissions.length, 0);
  await click(button(view.container, "Retry loading data"));
  await until(() => !view.container.querySelector("[data-testid=form-prefill-overlay]"));
  assert.equal(input(view.container).value, "Current affiliation");
  assert.equal(attempts, 2);
});

test("fresh snapshot waits for draft restoration and replaces only managed draft answers/token", async t => {
  const draft = deferred();
  const form = definition();
  form.fields.push({ id: "note", type: "text", label: "Note" });
  const view = await mount(t, { form, draft, search: "&draft=resume-fixture" });
  await until(() => view.calls.some(call => call.url.includes("/member-affiliations?")));
  assert.ok(view.container.querySelector("[data-testid=form-prefill-overlay]"));
  assert.notEqual(input(view.container).value, "Current affiliation");
  await act(async () => draft.resolve({ success: true, draft: { draft_data: {
    affiliation: "Old draft affiliation", note: "Keep this draft note", __member_affiliation_snapshot: "untrusted-token",
  } } }));
  await until(() => !view.container.querySelector("[data-testid=form-prefill-overlay]"));
  const values = [...view.container.querySelectorAll('input[type="text"]')].map(node => node.value);
  assert.deepEqual(values, ["Current affiliation", "Keep this draft note"]);
  await click(button(view.container, "Submit"));
  await until(() => view.submissions.length === 1);
  assert.equal(view.submissions[0].submission_data.__member_affiliation_snapshot, snapshot().snapshotToken);
  assert.equal(view.submissions[0].submission_data.note, "Keep this draft note");
});

test("snapshot wins over initial member prefill and subsequent conditional set-value rules", async t => {
  const form = definition();
  form.prefill_source = "member";
  form.fields[0].prefill_field = "member:first_name";
  form.fields.push({ id: "trigger", type: "text", label: "Trigger", default_value: "yes" });
  form.visibility_rules = [{ id: "legacy-set", trigger_field_id: "trigger", operator: "equals", value: "yes",
    action: "set_value", target_field_id: "affiliation", set_value_source: "static", set_value: "Conditional overwrite" }];
  const view = await mount(t, { form });
  await until(() => !view.container.querySelector("[data-testid=form-prefill-overlay]"));
  assert.equal(input(view.container).value, "Current affiliation");
  await edit(input(view.container), "Keep my managed edit");
  assert.equal(input(view.container).value, "Keep my managed edit");
});

test("late reactive field prefill cannot replace managed snapshot answers", async t => {
  const pending = deferred();
  const form = definition();
  form.prefill_source = "form_field";
  form.prefill_source_field_id = "source";
  form.fields[0].prefill_field = "org:name";
  form.fields.push({ id: "source", type: "organisation_dropdown", label: "Source",
    default_value: "source-org" });
  const view = await mount(t, { form, prefillRequest: () => pending.promise });
  await until(() => input(view.container)?.value === "Current affiliation");
  assert.ok(view.container.querySelector("[data-testid=form-prefill-overlay]"), "reactive prefill is still pending");
  await act(async () => pending.resolve({ values: { affiliation: "Late reactive overwrite" } }));
  await until(() => !view.container.querySelector("[data-testid=form-prefill-overlay]"));
  assert.equal(input(view.container).value, "Current affiliation");
  await edit(input(view.container), "Keep member edit");
  await click(button(view.container, "Submit"));
  await until(() => view.submissions.length === 1);
  assert.equal(view.submissions[0].submission_data.affiliation, "Keep member edit");
});

test("membership-payment initiation stays disabled until the snapshot is ready", async t => {
  const pending = deferred();
  const form = definition();
  form.prefill_source = "member";
  form.fields.push({ id: "payment", type: "membership_payment", label: "Renewal payment" });
  const view = await mount(t, { form, snapshotRequest: () => pending.promise });
  await until(() => !!view.container.querySelector("button[aria-pressed]"));
  const card = () => [...view.container.querySelectorAll("button[aria-pressed]")]
    .find(node => node.textContent.includes("Pay in full by card"));
  assert.equal(card().disabled, true);
  await click(card());
  assert.equal(view.calls.filter(call => call.options.method === "POST").length, 0);
  await act(async () => pending.resolve(json(snapshot())));
  await until(() => card() && !card().disabled);
  await click(card());
  const pay = view.container.querySelector('[data-testid="button-pay-membership-payment"]');
  assert.ok(pay);
  await click(pay);
  assert.equal(view.submissions.length, 0, "membership payment precedes normal form submission");
  const paymentPosts = view.calls.filter(call => call.url === "/api/forms/membership-payment" && call.options.method === "POST");
  assert.equal(paymentPosts.length, 1);
  assert.equal(JSON.parse(paymentPosts[0].options.body).action, "create_payment");
  assert.match(view.container.textContent, /Stopped before contacting payment provider/);
});

test("builder mounts separately saved settings against persisted form and verified tenant context", async () => {
  const source = await readFile("client/src/pages/FormBuilder.jsx", "utf8");
  assert.match(source, /<MemberAffiliationSettings\s+formId=\{formId \|\| null\}\s+tenantContext=\{alertTenantId\}\s+persistedForm=\{existingForm\}/);
});
