import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { memberCpdPresentation } from '../../../shared/memberCpdPresentation.js';

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/members/member-1",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.DocumentFragment = dom.window.DocumentFragment;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Event = dom.window.Event;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = handle => clearTimeout(handle);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Routes, Route, useLocation } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@radix-ui/react-tooltip");
// Bundle the view and its local contexts together while leaving package
// dependencies external. This supplies Vite's import.meta.env without starting
// a dev server or creating duplicate React/router package instances.
const bundlePath = path.join(process.cwd(), `.member-detail-related-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export { default as MemberDetailView } from "./client/src/components/MemberDetailView.jsx";
      export { LayoutProvider, useLayoutContext } from "./client/src/contexts/LayoutContext.jsx";
      export { default as MemberDetail } from "./client/src/pages/MemberDetail.jsx";
      export { default as AdminSettings } from "./client/src/pages/admin/AdminSettings.jsx";
      export { useMemberBalancesVisibility } from "./client/src/hooks/useMemberBalancesVisibility.js";
      export { default as MemberRecordCpdContent } from "./client/src/components/MemberRecordCpdContent.jsx";
    `,
    resolveDir: process.cwd(),
    loader: "jsx",
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  alias: { "@": path.join(process.cwd(), "client/src"), "@shared": path.join(process.cwd(), "shared") },
  define: { "import.meta.env": "{}" },
  plugins: [{
    name: 'public-image-fixture',
    setup(builder) {
      builder.onResolve({ filter: /^\/dougal-avatar\.webp$/ }, args => ({ path: args.path, namespace: 'fixture-image' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-image' }, () => ({ contents: 'export default "/dougal-avatar.webp";' }));
    },
  }],
  logLevel: "silent",
});
const bundled = await import(pathToFileURL(bundlePath).href);
const { MemberDetailView, LayoutProvider, useLayoutContext } = bundled;

function Identity({ children }) {
  const layout = useLayoutContext();
  useEffect(() => {
    layout.setMemberInfo({ id: "viewer-1", tenant_id: "tenant-1" });
    layout.setSessionValidated(true);
    layout.setAuthResolved(true);
  }, []);
  return children;
}

const member = id => ({
  id,
  first_name: id === "member-1" ? "First" : "Second",
  last_name: "Member",
  email: `${id}@example.test`,
  capabilities: { edit_records: false },
});

const definition = {
  id: "member-organisations",
  status: "active",
  cardinality: "many_to_many",
  source_kind: "member",
  target_kind: "organization",
  source_label: "Organisations",
  target_label: "Members",
  can_edit: false,
  edit_from_source: false,
};

const edgeRows = label => ({
  data: [{
    relationship_id: `edge-${label}`,
    related_kind: "organization",
    related_record_id: `org-${label}`,
    related: {
      id: `org-${label}`,
      kind: "organization",
      primary_label: label,
    },
  }],
  total: 1,
  pageSize: 10,
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const unrelatedResponse = path => path.includes("/api/entities/SystemSettings")
  ? json([{ setting_key: "role_segmentation_field_id", setting_value: "" }])
  : json([]);

function deferred() {
  let resolve;
  const promise = new Promise(res => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle(delay = 20) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, delay));
  });
}

async function waitFor(predicate) {
  for (let i = 0; i < 50 && !predicate(); i++) await settle(10);
  assert.ok(predicate(), 'Expected UI state did not resolve');
}

async function mount(child, initialEntries = ['/']) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const render = async next => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={initialEntries}>
            <TooltipProvider>
              <LayoutProvider><Identity>{next}</Identity></LayoutProvider>
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };
  await render(child);
  return {
    container,
    client,
    render,
    async cleanup() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

const propsFor = (value, extra = {}) => ({
  member: value,
  memberCustomFields: [],
  organizations: [],
  roles: [],
  ...extra,
});

async function selectTab(tab) {
  await act(async () => {
    tab.dispatchEvent(new dom.window.MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
    }));
  });
  await settle();
}

test("discovers delayed definitions on overview, then loads the selected relationship tab", async () => {
  const definitions = deferred();
  const rows = deferred();
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("/core/relationship-definitions")) return definitions.promise;
    if (path.includes("/core/relationships")) return rows.promise;
    return unrelatedResponse(path);
  };

  const view = await mount(<MemberDetailView {...propsFor(member("member-1"))} />);
  assert.ok(view.container.querySelector('[data-testid="related-records-loading"]'));
  assert.equal(view.container.querySelector("[data-relationship-discovery]"), null);

  definitions.resolve(json({
    data: [{ definition, side: "source", count: 1 }],
    total: 1,
  }));
  await settle();
  const tab = view.container.querySelector('[data-testid="tab-relationship-member-organisations-source"]');
  assert.ok(tab);
  await selectTab(tab);
  assert.equal(tab.getAttribute("data-state"), "active");
  assert.ok(view.container.querySelector('[data-testid="related-records-loading"]'));

  rows.resolve(json(edgeRows("Loaded organisation")));
  await settle();
  assert.equal(view.container.querySelector("[data-relationship-discovery]"), null);
  assert.match(view.container.textContent, /Loaded organisation/);
  const panel = view.container.querySelector('[role="tabpanel"][data-state="active"]');
  assert.ok(panel);
  assert.ok(panel.getAttribute("aria-labelledby"));
  await view.cleanup();
});

test("prop identity changes never retain the previous tab rows and reset for new or id-less members", async () => {
  const secondDefinitions = deferred();
  const secondRows = deferred();
  let firstDefinitionsDone = false;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("/core/relationship-definitions")) {
      const recordId = new URL(path, "https://tenant.example.test").searchParams.get("recordId");
      if (recordId === "member-2") return secondDefinitions.promise;
      firstDefinitionsDone = true;
      return json({ data: [{ definition, side: "source" }], total: 1 });
    }
    if (path.includes("/core/relationships")) {
      const recordId = new URL(path, "https://tenant.example.test").searchParams.get("recordId");
      return recordId === "member-2"
        ? secondRows.promise
        : json(edgeRows("Old organisation"));
    }
    return unrelatedResponse(path);
  };

  const view = await mount(<MemberDetailView {...propsFor(member("member-1"))} />);
  assert.equal(firstDefinitionsDone, true);
  const tab = view.container.querySelector('[data-testid^="tab-relationship-"]');
  await selectTab(tab);
  assert.match(view.container.textContent, /Old organisation/);

  await view.render(<MemberDetailView {...propsFor(member("member-2"))} />);
  assert.doesNotMatch(view.container.textContent, /Old organisation/);
  assert.ok(view.container.querySelector("[data-relationship-discovery]"));
  assert.equal(
    view.container.querySelector('[role="tabpanel"][aria-labelledby*="relationship"]'),
    null,
  );

  await view.render(<MemberDetailView {...propsFor({}, { isNew: true })} />);
  assert.ok(view.container.querySelector('[data-testid="tab-member-overview"][data-state="active"]'));
  assert.equal(view.container.querySelector("[data-relationship-discovery]"), null);
  assert.equal(view.container.querySelector('[data-testid="related-records-loading"]'), null);

  await view.render(<MemberDetailView {...propsFor({})} />);
  assert.ok(view.container.querySelector('[data-testid="tab-member-overview"][data-state="active"]'));
  assert.equal(view.container.querySelector("[data-relationship-discovery]"), null);
  assert.equal(view.container.querySelector('[data-testid="related-records-loading"]'), null);
  await view.cleanup();
});

test("definition failure on the reusable view exposes Retry and recovers", async () => {
  let definitionCalls = 0;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("/core/relationship-definitions")) {
      definitionCalls += 1;
      return definitionCalls === 1
        ? json({ error: "Definitions unavailable" }, 503)
        : json({ data: [], total: 0 });
    }
    return unrelatedResponse(path);
  };

  const view = await mount(<MemberDetailView {...propsFor(member("member-1"))} />);
  const alert = [...view.container.querySelectorAll('[role="alert"]')]
    .find(item => item.textContent.includes("Records could not be loaded"));
  assert.ok(alert);
  const retry = [...alert.querySelectorAll("button")]
    .find(button => button.textContent.includes("Retry"));
  await act(async () => retry.click());
  await settle();
  assert.equal(definitionCalls, 2);
  assert.equal(
    [...view.container.querySelectorAll('[role="alert"]')]
      .some(item => item.textContent.includes("Records could not be loaded")),
    false,
  );
  assert.equal(view.container.querySelector('[data-testid="related-records-loading"]'), null);
  await view.cleanup();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone' : 'embedded'} member tabs omit CRM-only relationships`, async () => {
    const labels = ["Organisation Departments", "Secondary Organisation Assignments", "Historical Membership Records"];
    globalThis.fetch = async url => {
      const path = String(url);
      if (path.includes("/core/relationship-definitions")) return json({
        data: [
          { definition, side: "source" },
          ...labels.map((label, index) => ({
            definition: { ...definition, id: `card-only-${index}`, source_label: label },
            side: "source",
          })),
        ],
        total: 4,
      });
      if (/\/api\/entities\/Member\/member-1/.test(path)) return json(member("member-1"));
      return unrelatedResponse(path);
    };
    const child = standalone
      ? <><Routes><Route path="/members/:id" element={<bundled.MemberDetail />} /></Routes><LocationProbe /></>
      : <MemberDetailView {...propsFor(member("member-1"))} />;
    const view = await mount(child, ['/members/member-1?tab=relationship-card-only-0-source&keep=yes']);
    assert.ok(view.container.querySelector('[data-testid="tab-relationship-member-organisations-source"]'));
    for (let index = 0; index < labels.length; index++) {
      assert.equal(view.container.querySelector(`[data-testid="tab-relationship-card-only-${index}-source"]`), null);
    }
    if (standalone) {
      assert.ok(view.container.querySelector('[data-testid="tab-member-overview"][data-state="active"]'));
      const params = new URLSearchParams(view.container.querySelector('output').textContent);
      assert.equal(params.get('keep'), 'yes');
      assert.notEqual(params.get('tab'), 'relationship-card-only-0-source');
    }
    await view.cleanup();
  });
}

function PreferenceProbe({ tenantId }) {
  const preference = bundled.useMemberBalancesVisibility(tenantId);
  return <output data-testid="preference">{String(preference.visible)}:{String(preference.cpdVisible)}:{preference.cpdTabLabel}</output>;
}

test('preference caches never reuse another tenant, even during failed loads', async () => {
  globalThis.fetch = async (_url, options) => options.headers.get('X-Tenant-Id') === 'tenant-1'
    ? json({ tenantId: 'tenant-1', show_member_balances_tab: true, show_member_cpd_points: true, member_cpd_tab_label: 'Awards' })
    : json({ error: 'unavailable' }, 503);
  const view = await mount(<PreferenceProbe tenantId="tenant-1" />);
  assert.equal(view.container.textContent, 'true:true:Awards');
  await view.render(<PreferenceProbe tenantId="tenant-2" />);
  assert.equal(view.container.textContent, 'false:false:CPD points');
  await view.cleanup();
});

test('settings switch saves, invalidates the member preference, and reloads the saved value', async () => {
  let settings = {};
  let failSave = false;
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.includes('/api/auth/tenant-user-me')) return json({
      authenticated: true, tenantUser: { role: 'admin' },
      tenant: { id: 'tenant-1', name: 'Fixture tenant', settings },
    });
    if (path === '/api/admin/tenant') {
      if (failSave) return json({ error: 'unavailable' }, 503);
      writes.push(JSON.parse(options.body));
      settings = { ...settings, ...writes.at(-1).settings, ...memberCpdPresentation(writes.at(-1).settings) };
      return json({ tenant: { id: 'tenant-1', settings } });
    }
    return unrelatedResponse(path);
  };
  let view = await mount(<bundled.AdminSettings />);
  let control = view.container.querySelector('#show-member-balances-tab');
  assert.ok(control);
  assert.equal(control.getAttribute('aria-checked'), 'true');
  const cpdControl = view.container.querySelector('#show-member-cpd-points');
  assert.equal(cpdControl.getAttribute('aria-checked'), 'true');
  assert.equal(view.container.querySelector('#member-cpd-tab-label').value, 'CPD points');
  await act(async () => cpdControl.click());
  await act(async () => {
    const input = view.container.querySelector('#member-cpd-tab-label');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'Learning awards');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  view.client.setQueryDefaults(['member-record-preferences', 'tenant-1'], { gcTime: Infinity });
  view.client.setQueryData(['member-record-preferences', 'tenant-1'], { tenantId: 'tenant-1', show_member_balances_tab: true });
  await act(async () => control.click());
  await act(async () => view.container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  assert.equal(writes.at(-1).settings.show_member_balances_tab, false);
  assert.equal(writes.at(-1).settings.show_member_cpd_points, false);
  assert.equal(writes.at(-1).settings.member_cpd_tab_label, 'Learning awards');
  assert.equal(view.client.getQueryState(['member-record-preferences', 'tenant-1']).isInvalidated, true);
  await view.cleanup();
  view = await mount(<bundled.AdminSettings />);
  control = view.container.querySelector('#show-member-balances-tab');
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(view.container.querySelector('#show-member-cpd-points').getAttribute('aria-checked'), 'false');
  assert.equal(view.container.querySelector('#member-cpd-tab-label').value, 'Learning awards');
  failSave = true;
  await act(async () => control.click());
  await act(async () => view.container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  assert.equal(settings.show_member_balances_tab, false);
  failSave = false;
  await act(async () => {
    const input = view.container.querySelector('#member-cpd-tab-label');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, '   ');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => view.container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  assert.equal(view.container.querySelector('#member-cpd-tab-label').value, 'CPD points');
  assert.equal(settings.member_cpd_tab_label, 'CPD points');
  await view.cleanup();
});

test('member CPD deep link keeps Speaker Awards and plain-text custom label while hiding all points requests', async t => {
  const calls = [];
  let visible = false;
  globalThis.fetch = async url => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/api/member-record-preferences')) return json({
      tenantId: 'tenant-1', show_member_balances_tab: true,
      show_member_cpd_points: visible, member_cpd_tab_label: '<b>Learning</b>',
    });
    if (/\/api\/entities\/Member\/member-1/.test(path)) return json(member('member-1'));
    if (path.includes('/core/relationship-definitions')) return json({ data: [], total: 0 });
    if (path.includes('/speaker-awards')) return json({ awards: [], pagination: { total: 0 } });
    if (path.includes('/cpd-points')) return json({ balance: 12, items: [], total: 0 });
    return unrelatedResponse(path);
  };
  const view = await mount(<><Routes><Route path="/members/:id" element={<bundled.MemberDetail />} /></Routes><LocationProbe /></>,
    ['/members/member-1?tab=cpd-points&keep=one%26two']);
  t.after(() => view.cleanup());
  await waitFor(() => view.container.textContent.includes('No speaker awards recorded yet'));
  const tab = view.container.querySelector('[data-testid="tab-member-cpd-points"]');
  assert.equal(tab.getAttribute('data-state'), 'active');
  assert.equal(tab.textContent, '<b>Learning</b>');
  assert.equal(tab.querySelector('b'), null);
  assert.match(view.container.textContent, /Speaker Awards.*No speaker awards recorded yet/);
  assert.equal(view.container.querySelector('[data-testid="member-cpd-points-balance"]'), null);
  assert.equal(calls.some(path => /cpd-points|cpd-certificate|manual-cpd-awards/.test(path)), false);
  assert.equal(calls.filter(path => path.includes('/member-record-preferences')).length, 1);
  visible = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['member-record-preferences'] }); });
  await waitFor(() => view.container.querySelector('[data-testid="member-cpd-points-balance"]'));
  assert.equal(view.container.querySelector('[data-testid="member-cpd-points-balance"]').textContent, '12');
  assert.match(view.container.textContent, /Points history/);
  assert.equal(new URLSearchParams(view.container.querySelector('[data-testid="location"]').textContent).get('tab'), 'cpd-points');
  visible = false;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['member-record-preferences'] }); });
  await settle();
  assert.equal(view.container.querySelector('[data-testid="member-cpd-points-balance"]'), null);
  assert.match(view.container.textContent, /No speaker awards recorded yet/);
});

function CpdPreferenceProbe({ tenantId }) {
  const preferences = bundled.useMemberBalancesVisibility(tenantId);
  return <>
    <output>{preferences.cpdTabLabel}</output>
    <bundled.MemberRecordCpdContent memberId={`${tenantId}-member`} preferences={preferences} enabled canCorrect />
    <PreferenceProbe tenantId={tenantId} />
  </>;
}

test('CPD pending, failed and switched-tenant preferences never mount hidden controls or query the ledger', async t => {
  const calls = [];
  let pending = deferred();
  let mode = 'pending';
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/member-record-preferences')) {
      if (mode === 'pending') return pending.promise;
      if (mode === 'error') return json({ error: 'offline' }, 503);
      const tenantId = options.headers.get('X-Tenant-Id');
      if (mode === 'wrong-tenant') return json({ tenantId: 'wrong', show_member_balances_tab: true, show_member_cpd_points: true, member_cpd_tab_label: 'Wrong' });
      return json({ tenantId, show_member_balances_tab: true, show_member_cpd_points: mode === 'show', member_cpd_tab_label: `Awards ${tenantId}` });
    }
    if (path.includes('/speaker-awards')) return json({ awards: [{
      id: 'speaker-award', event_title: 'Speaker forum', status: 'granted',
      certificate: { available: true, status: 'issued' },
    }], pagination: { total: 1, total_pages: 1 } });
    if (path.includes('/cpd-certificate')) return json({ certificates: { award: { available: true } } });
    if (path.includes('/api/admin/member-cpd-points')) return json({ entries: [] });
    if (path.includes('/cpd-points')) return json({ balance: 3, total: 1, items: [{
      id: 'award', entry_kind: 'event_award', points_value: 3, event_name: 'Learning forum',
    }] });
    assert.fail(`Unexpected request: ${path}`);
  };
  const view = await mount(<CpdPreferenceProbe tenantId="a" />, ['/members/a-member?tab=cpd-points']);
  t.after(() => view.cleanup());
  const assertNoPoints = () => {
    assert.equal(view.container.querySelector('[data-testid="member-cpd-points-balance"]'), null);
    assert.doesNotMatch(view.container.textContent, /Points history|Award manual CPD|Adjust/);
  };
  assertNoPoints();
  await waitFor(() => view.container.textContent.includes('Speaker forum'));
  assert.match(view.container.textContent, /Speaker forum/);
  assert.ok([...view.container.querySelectorAll('button')].some(button => button.textContent === 'Preview'));
  assert.equal(calls.filter(path => path.includes('/member-record-preferences')).length, 1, 'two consumers share one pending request');
  pending.resolve(json({ error: 'offline' }, 503));
  await settle();
  assertNoPoints();
  assert.match(view.container.textContent, /Could not load member record preferences/);
  mode = 'hide';
  await act(async () => [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Retry preferences').click());
  await settle();
  assertNoPoints();
  assert.match(view.container.textContent, /Awards a/);
  assert.equal(calls.some(path => /cpd-points|cpd-certificate|manual-cpd-awards/.test(path)), false);
  mode = 'show';
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['member-record-preferences'] }); });
  await waitFor(() => view.container.querySelector('[data-testid="member-cpd-points-balance"]'));
  await waitFor(() => calls.some(path => path.includes('/cpd-certificate')));
  assert.ok(view.container.querySelector('[data-testid="member-cpd-points-balance"]'));
  assert.ok(calls.some(path => path.includes('/api/admin/member-cpd-points')));
  assert.ok(calls.some(path => path.includes('/cpd-certificate')));
  mode = 'pending';
  pending = deferred();
  const beforeSwitch = calls.length;
  await view.render(<CpdPreferenceProbe tenantId="b" />);
  assertNoPoints();
  assert.doesNotMatch(view.container.textContent, /Awards a|Learning forum/);
  mode = 'hide';
  pending.resolve(json({ tenantId: 'b', show_member_balances_tab: true, show_member_cpd_points: false, member_cpd_tab_label: 'Awards b' }));
  await settle();
  assertNoPoints();
  assert.equal(calls.slice(beforeSwitch).some(path => /cpd-points|cpd-certificate|manual-cpd-awards/.test(path)), false);
  mode = 'wrong-tenant';
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['member-record-preferences', 'b'] }); });
  await settle();
  assertNoPoints();
  assert.doesNotMatch(view.container.textContent, /Wrong|Awards a/);
});

test('a late preference response cannot restore the previous tenant CPD display', async t => {
  const oldResponse = deferred();
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/member-record-preferences')) {
      if (options.headers.get('X-Tenant-Id') === 'a') return oldResponse.promise;
      return json({ tenantId: 'b', show_member_balances_tab: true, show_member_cpd_points: false, member_cpd_tab_label: 'B awards' });
    }
    if (path.includes('/speaker-awards')) return json({ awards: [], pagination: { total: 0 } });
    assert.fail(`Unexpected request: ${path}`);
  };
  const view = await mount(<CpdPreferenceProbe tenantId="a" />);
  t.after(() => view.cleanup());
  await view.render(<CpdPreferenceProbe tenantId="b" />);
  await waitFor(() => view.container.textContent.includes('B awards'));
  oldResponse.resolve(json({ tenantId: 'a', show_member_balances_tab: true, show_member_cpd_points: true, member_cpd_tab_label: 'A points' }));
  await settle();
  assert.doesNotMatch(view.container.textContent, /A points|Points history/);
  assert.equal(view.container.querySelector('[data-testid="member-cpd-points-balance"]'), null);
  assert.equal(calls.some(path => /cpd-points|cpd-certificate|manual-cpd-awards/.test(path)), false);
});

test('non-admin settings viewers cannot edit either CPD presentation control', async t => {
  globalThis.fetch = async url => String(url).includes('/api/auth/tenant-user-me') ? json({
    authenticated: true, tenantUser: { role: 'viewer' },
    tenant: { id: 'tenant-1', name: 'Fixture', settings: {} },
  }) : unrelatedResponse(String(url));
  const view = await mount(<bundled.AdminSettings />);
  t.after(() => view.cleanup());
  assert.equal(view.container.querySelector('#show-member-cpd-points').disabled, true);
  assert.equal(view.container.querySelector('#member-cpd-tab-label').disabled, true);
});

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone' : 'embedded'} balances stay hidden during pending/error, restore unchanged data, and reset when disabled`, async () => {
    let pending = deferred();
    let mode = 'pending';
    globalThis.fetch = async url => {
      const path = String(url);
      if (path.includes('/api/member-record-preferences')) {
        if (mode === 'pending') return pending.promise;
        if (mode === 'error') return json({ error: 'unavailable' }, 503);
        return json({ tenantId: 'tenant-1', show_member_balances_tab: mode === 'true', show_member_cpd_points: true, member_cpd_tab_label: 'CPD points' });
      }
      if (/\/api\/entities\/Member\/member-1/.test(path)) return json({
        ...member('member-1'), opening_balances: { eventsAttended: 42 },
      });
      if (path.includes('/core/relationship-definitions')) return json({ data: [], total: 0 });
      return unrelatedResponse(path);
    };
    const child = standalone
      ? <><Routes><Route path="/members/:id" element={<bundled.MemberDetail />} /></Routes><LocationProbe /></>
      : <MemberDetailView {...propsFor({ ...member('member-1'), engagement_opening_balances: { eventsAttended: 42 } })} />;
    const view = await mount(child, ['/members/member-1?tab=balances&keep=one%26two']);
    const tab = () => view.container.querySelector('[data-testid="tab-member-balances"]');
    assert.equal(tab(), null);
    mode = 'error';
    pending.resolve(json({ error: 'unavailable' }, 503));
    await settle();
    assert.equal(tab(), null);
    assert.equal(view.container.querySelector('[data-testid="button-save-balances"]'), null);
    mode = 'true';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['member-record-preferences'] }); });
    await settle();
    assert.ok(tab());
    await selectTab(tab());
    assert.ok(view.container.querySelector('[data-testid="button-save-balances"]'));
    assert.ok([...view.container.querySelectorAll('input')].some(input => input.value === '42'));
    mode = 'false';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['member-record-preferences'] }); });
    await settle();
    assert.equal(tab(), null);
    assert.equal(view.container.querySelector('[data-testid="button-save-balances"]'), null);
    assert.ok(view.container.querySelector('[data-testid="tab-member-overview"][data-state="active"]'));
    if (standalone) {
      const params = new URLSearchParams(view.container.querySelector('output').textContent);
      assert.equal(params.get('keep'), 'one&two');
      assert.notEqual(params.get('tab'), 'balances');
    }
    mode = 'true';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['member-record-preferences'] }); });
    await settle();
    await selectTab(tab());
    assert.ok([...view.container.querySelectorAll('input')].some(input => input.value === '42'));
    await view.cleanup();
  });
}

test.after(async () => {
  await unlink(bundlePath).catch(() => {});
});