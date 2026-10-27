import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Mount the real admin page, member balances and booking selector. All data,
// permissions and browser requests are isolated fixtures; no live writes.
// node scripts/run-isolated-tests.mjs node --test client/src/components/vouchers/MembershipVoucherDisplays.mounted.test.mjs
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
let QueryClient, QueryClientProvider;
const ui = `
  import React from "react";
  const wrap = tag => ({children, variant, size, asChild, ...props}) => React.createElement(tag, props, children);
  export const Card = ({children,...props}) => React.createElement("div", {...props,"data-card":true}, children);
  export const CardContent=wrap("div"), CardHeader=wrap("div"), CardTitle=wrap("h2"), Button=wrap("button"), Input=wrap("input"), Textarea=wrap("textarea"), Label=wrap("label"), Badge=wrap("span");
  export const Dialog=({open,children}) => open ? React.createElement("div",{role:"dialog"},children):null;
  export const DialogContent=wrap("div"), DialogHeader=wrap("div"), DialogTitle=wrap("h2"), DialogFooter=wrap("div"), DialogDescription=wrap("p");
  export const Checkbox=({checked,onCheckedChange,...props}) => React.createElement("input",{...props,type:"checkbox",checked:checked===true,onChange:e=>onCheckedChange?.(e.target.checked)});
  export const Switch=Checkbox;
  export const SelectItem=wrap("option"), SelectTrigger=wrap("span"), SelectContent=wrap("span"), SelectValue=wrap("span");
  function flatten(children,out=[],meta={}) {React.Children.forEach(children,node=>{if(!React.isValidElement(node))return;if(node.type===SelectItem)out.push(React.createElement("option",{key:node.props.value,value:node.props.value},node.props.children));else {if(node.props["data-testid"])meta.id=node.props["data-testid"];flatten(node.props.children,out,meta);}});return {out,meta};}
  export const Select=({children,value,onValueChange})=>{const {out,meta}=flatten(children);return React.createElement("select",{"data-testid":meta.id,value,onChange:e=>onValueChange(e.target.value)},out)};
  const TabsContext=React.createContext(null);
  export const Tabs=({children,defaultValue})=>{const [value,setValue]=React.useState(defaultValue);return React.createElement(TabsContext.Provider,{value:{value,setValue}},children)};
  export const TabsList=wrap("div");
  export const TabsTrigger=({value,children,...props})=>{const tabs=React.useContext(TabsContext);return React.createElement("button",{...props,onClick:()=>tabs.setValue(value)},children)};
  export const TabsContent=({value,children})=>React.useContext(TabsContext).value===value?React.createElement("div",null,children):null;
  export const Popover=wrap("div"), PopoverContent=wrap("div"), PopoverTrigger=wrap("div"), Command=wrap("div"), CommandEmpty=wrap("div"), CommandGroup=wrap("div"), CommandInput=wrap("input"), CommandItem=wrap("div"), CommandList=wrap("div"), ScrollArea=wrap("div"), Calendar=()=>null;
`;
const entries = {
  admin: "client/src/pages/VoucherManagement.jsx",
  balances: "client/src/pages/Balances.jsx",
  selector: "client/src/components/booking/VoucherSelector.jsx",
};
const Components = {};
for (const [name, entry] of Object.entries(entries)) {
  const bundle = await build({
    entryPoints: [entry], bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
    plugins: [{
      name: "voucher-display-isolated-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
        builder.onResolve({ filter: /^sonner$/ }, args => ({ path: args.path, namespace: "fixture" }));
        builder.onResolve({ filter: /^@\// }, args => args.path.endsWith("/vouchers/VoucherPresentation")
          ? { path: `${process.cwd()}/client/src/components/vouchers/VoucherPresentation.jsx` }
          : { path: args.path, namespace: "fixture" });
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => {
          let contents = "export default function Stub(){return null}";
          if (path.includes("/ui/")) contents = ui;
          else if (path.endsWith("base44Client")) contents = `export const base44={entities:new Proxy({}, {get:(_,entity)=>new Proxy({}, {get:(_,method)=>(...args)=>globalThis.voucherEntity(entity,method,args)})}),functions:{invoke:async()=>({data:{personal_balances:{},entitlements:[]}})}};`;
          else if (path.endsWith("publicClient")) contents = "export const publicClient={listSystemSettings:async()=>({individual_vouchers_enabled:true})};";
          else if (path.endsWith("useMemberAccess")) contents = "export const useMemberAccess=()=>globalThis.voucherAccess;";
          else if (path.endsWith("useTicketViewerKey")) contents = "export const useTicketViewerKey=member=>[member?.tenant_id,member?.id];";
          else if (path.endsWith("useAdminBalancesRealtime")) contents = "export const useAdminBalancesRealtime=()=>({isConnected:false});";
          else if (path.endsWith("useBalancesRealtime")) contents = "export const useBalancesRealtime=()=>({isConnected:false});";
          else if (path.endsWith("useSavedExportReports")) contents = "export const useSavedExportReports=()=>({reports:[],refetch:()=>{},activeReportId:null,setActiveReportId:()=>{},activeReport:null,isSaving:false});";
          else if (path.endsWith("adminOrgList")) contents = "export const listOrganizationsForAdmin=async()=>[{id:'org-owner',name:'Institute of Practice'}];";
          else if (path.endsWith("adminFetch")) contents = "export const adminFetch=(url,options={},tenantId)=>globalThis.fetch(url,{...options,credentials:'include',headers:{...options.headers,'X-Tenant-Id':tenantId}});";
          else if (path === "@/utils") contents = "export const createPageUrl=name=>'/'+name;";
          else if (path === "sonner") contents = "export const toast={error:(...args)=>globalThis.voucherToasts.push(args),success:()=>{},info:()=>{}};";
          return { loader: "js", contents };
        });
      },
    }],
  });
  const compiled = new Module(`${process.cwd()}/voucher-${name}-mounted.cjs`);
  compiled.filename = `${process.cwd()}/voucher-${name}-mounted.cjs`;
  compiled.paths = Module._nodeModulePaths(process.cwd());
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  ({ QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query"));
  Components[name] = compiled.exports.default;
}
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); delete globalThis.voucherEntity; delete globalThis.voucherAccess; delete globalThis.voucherToasts; });
const member = { id: "member-owner", tenant_id: "tenant-isolated", role_id: "role-admin" };
const baseVoucher = (id, overrides = {}) => ({
  id, code: id.toUpperCase(), value: 43.27, status: "active", member_id: member.id, organization_id: null,
  expires_at: "2099-06-17T00:00:00Z", issued_at: "2026-04-17T00:00:00Z", created_at: "2026-04-17T00:00:00Z", ...overrides,
});
const fixture = () => [
  baseVoucher("member-credit", { funding_source: "membership_change", expires_at: null }),
  baseVoucher("dated-credit", { funding_source: "membership_change" }),
  baseVoucher("personal", { funding_source: "manual" }),
  baseVoucher("organization", { funding_source: "manual", member_id: null, organization_id: "org-owner" }),
];
const byTestId = id => document.querySelector(`[data-testid="${id}"]`);
async function waitFor(predicate) {
  for (let i = 0; i < 90; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.fail("Timed out waiting for mounted voucher UI");
}
const click = async node => {
  assert.ok(node, "interactive element exists"); assert.notEqual(node.disabled, true);
  await act(async () => node.click());
};
async function change(node, value) {
  const proto = node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function mount(name, { vouchers = fixture(), props = {} } = {}) {
  const reads = [], writes = [];
  globalThis.voucherToasts = [];
  globalThis.voucherAccess = {
    isAdmin: true, isAccessReady: true, memberInfo: member, organizationInfo: null,
    isFeatureExcluded: () => false,
  };
  globalThis.fetch = async url => {
    assert.match(url, /^\/api\/admin\/voucher-transactions/);
    reads.push({ url });
    return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
  };
  globalThis.voucherEntity = async (entity, method, args) => {
    if (["create", "update", "delete"].includes(method)) {
      writes.push({ entity, method, args });
      if (entity === "Voucher") {
        assert.notEqual(vouchers.find(row => row.id === args[0])?.funding_source, "membership_change", "No generated membership credit may be written");
        if (method === "update") vouchers = vouchers.map(row => row.id === args[0] ? { ...row, ...args[1] } : row);
        if (method === "delete") vouchers = vouchers.filter(row => row.id !== args[0]);
      }
      return args[1] || {};
    }
    reads.push({ entity, method, args });
    if (entity === "SystemSettings") return [{ setting_key: "individual_vouchers_enabled", setting_value: "true" }];
    if (entity === "Voucher") return method === "filter" ? vouchers.filter(v => Object.entries(args[0]).every(([key, value]) => v[key] === value)) : vouchers;
    if (entity === "Member") return { id: args[0], first_name: "Mara", last_name: "Ellis" };
    return [];
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const initial = name === "selector" ? { memberInfo: member, organizationInfo: null, selectedVouchers: [], onVoucherToggle: () => {}, maxAmount: 117.43, ...props } : props;
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Components[name], initial))));
  await waitFor(() => name === "admin" ? byTestId("card-voucher-member-credit") : name === "selector" ? byTestId("voucher-option-member-credit") : [...container.querySelectorAll("h3")].some(node => node.textContent.includes("MEMBER-CREDIT")));
  return { container, client, reads, writes, async cleanup() {
    await waitFor(() => client.isMutating() === 0);
    await act(async () => { await client.cancelQueries(); root.unmount(); });
    client.clear(); container.remove();
  } };
}

test("admin null-expiry membership credits are active and read-only; ordinary member/org controls remain", async () => {
  const view = await mount("admin");
  try {
    for (const id of ["member-credit", "dated-credit"]) {
      assert.ok(byTestId(`card-voucher-${id}`));
      assert.equal(byTestId(`button-edit-voucher-${id}`), null);
      assert.equal(byTestId(`button-delete-voucher-${id}`), null);
      assert.equal(byTestId(`checkbox-select-voucher-${id}`), null);
      assert.match(byTestId(`card-voucher-${id}`).textContent, /managed by membership financial operations/);
    }
    assert.match(byTestId("card-voucher-member-credit").textContent, /No expiry/);
    assert.match(byTestId("card-voucher-member-credit").textContent, /Active/);
    assert.doesNotMatch(byTestId("card-voucher-member-credit").textContent, /1970|Expired/);
    for (const id of ["personal", "organization"]) {
      assert.ok(byTestId(`button-edit-voucher-${id}`));
      assert.ok(byTestId(`button-delete-voucher-${id}`));
      assert.ok(byTestId(`checkbox-select-voucher-${id}`));
    }
    await change(byTestId("select-status-filter"), "active");
    assert.ok(byTestId("card-voucher-member-credit"));
    await click(byTestId("card-voucher-member-credit"));
    await waitFor(() => byTestId("button-back-to-vouchers"));
    assert.match(view.container.textContent, /No expiry/);
    assert.match(view.container.textContent, /managed by membership financial operations/);
    assert.doesNotMatch(view.container.textContent, /1970/);
    assert.equal(view.writes.length, 0);
  } finally { await view.cleanup(); }
});

test("select-all and bulk expiry adjustment include only ordinary vouchers, including when generated credit has an expiry", async () => {
  const view = await mount("admin");
  try {
    await click(byTestId("checkbox-select-all-page"));
    assert.equal(byTestId("badge-selected-count").textContent, "2 selected");
    await click(byTestId("button-bulk-adjust-expiry"));
    await change(byTestId("input-bulk-expiry-days"), "11");
    await click(byTestId("button-confirm-bulk-expiry"));
    await waitFor(() => view.writes.length === 2);
    assert.deepEqual(view.writes.map(write => write.args[0]).sort(), ["organization", "personal"]);
    assert.ok(view.writes.every(write => write.method === "update"));
  } finally { await view.cleanup(); }
});

test("an all-generated page has no ordinary expiry selection or adjustment action", async () => {
  const view = await mount("admin", { vouchers: fixture().filter(v => v.funding_source === "membership_change") });
  try {
    assert.equal(byTestId("checkbox-select-all-page").disabled, true);
    assert.equal(byTestId("button-bulk-adjust-expiry"), null);
    assert.equal(view.writes.length, 0);
  } finally { await view.cleanup(); }
});

test("ordinary edit/delete dialogs remain usable and close if a refreshed row becomes protected", async () => {
  const view = await mount("admin");
  try {
    await click(byTestId("button-edit-voucher-personal"));
    await waitFor(() => document.querySelector('[role="dialog"]'));
    assert.ok(byTestId("button-save-voucher"));
    await act(async () => view.client.setQueryData(["vouchers-admin", member.tenant_id, member.id], previous => previous.map(v => v.id === "personal" ? { ...v, funding_source: "membership_change" } : v)));
    await waitFor(() => !document.querySelector('[role="dialog"]'));
    assert.equal(byTestId("button-edit-voucher-personal"), null);
    await click(byTestId("button-delete-voucher-organization"));
    await waitFor(() => byTestId("button-confirm-delete"));
    assert.equal(byTestId("button-confirm-delete").disabled, false);
    await act(async () => view.client.setQueryData(["vouchers-admin", member.tenant_id, member.id], previous => previous.map(v => v.id === "organization" ? { ...v, funding_source: "membership_change" } : v)));
    await waitFor(() => !document.querySelector('[role="dialog"]'));
    assert.equal(byTestId("button-delete-voucher-organization"), null);
    assert.equal(view.writes.length, 0);
  } finally { await view.cleanup(); }
});

test("ordinary personal edit and organisation delete still complete through their existing mutations", async () => {
  const view = await mount("admin");
  try {
    await click(byTestId("button-edit-voucher-personal"));
    await waitFor(() => byTestId("input-voucher-value"));
    await change(byTestId("input-voucher-value"), "39.41");
    await click(byTestId("button-save-voucher"));
    await waitFor(() => view.writes.some(write => write.method === "update"));
    assert.equal(view.writes[0].args[0], "personal");
    assert.equal(view.writes[0].args[1].value, 39.41);
    await waitFor(() => !document.querySelector('[role="dialog"]'));
    await click(byTestId("button-delete-voucher-organization"));
    await click(byTestId("button-confirm-delete"));
    await waitFor(() => view.writes.some(write => write.method === "delete"));
    assert.equal(view.writes.at(-1).args[0], "organization");
    assert.equal(byTestId("button-edit-voucher-member-credit"), null);
  } finally { await view.cleanup(); }
});

test("member balance cards show no-expiry credit under active, without epoch date or expiring-soon warning", async () => {
  const view = await mount("balances");
  try {
    const heading = [...view.container.querySelectorAll("h3")].find(node => node.textContent.includes("MEMBER-CREDIT"));
    const card = heading.closest("[data-card]");
    assert.match(card.textContent, /No expiry/);
    assert.match(card.textContent, /managed by membership financial operations/);
    assert.doesNotMatch(card.textContent, /1970|expires soon|Expired/);
    assert.match(byTestId("tab-active-vouchers").textContent, /Active \(3\)/);
    await click(byTestId("tab-expired-vouchers"));
    assert.doesNotMatch(view.container.textContent, /MEMBER-CREDIT/);
    assert.equal(view.writes.length, 0);
  } finally { await view.cleanup(); }
});

test("booking displays no-expiry credit without enabling membership-only funds for events; ordinary no-expiry vouchers remain eligible", async () => {
  let selected;
  const view = await mount("selector", {
    vouchers: [...fixture(), baseVoucher("ordinary-no-expiry", { funding_source: "manual", expires_at: null, value: 19.73 })],
    props: { eventStartDate: "2090-04-17", restrictToEventDate: true, onVoucherToggle: value => { selected = value; } },
  });
  try {
    const credit = byTestId("voucher-option-member-credit");
    assert.match(credit.textContent, /No expiry/);
    assert.doesNotMatch(credit.textContent, /1970|days|expires before|Expired/);
    assert.match(credit.textContent, /eligible membership payments only/);
    assert.equal(credit.querySelector('input[type="checkbox"]').disabled, true);
    const ids = [...view.container.querySelectorAll('[data-testid^="voucher-option-"]')].map(node => node.getAttribute("data-testid"));
    assert.equal(ids.at(-1), "voucher-option-member-credit");
    const ordinary = byTestId("voucher-option-ordinary-no-expiry");
    assert.match(ordinary.textContent, /No expiry/);
    await click(ordinary.querySelector('input[type="checkbox"]'));
    assert.deepEqual(selected, ["ordinary-no-expiry"]);
    assert.equal(view.writes.length, 0);
  } finally { await view.cleanup(); }
});

test("previously selected membership-only credit is removed from event booking selection without financial writes", async () => {
  let selected;
  const view = await mount("selector", { props: { selectedVouchers: ["member-credit", "personal"], onVoucherToggle: value => { selected = value; } } });
  try {
    await waitFor(() => selected);
    assert.deepEqual(selected, ["personal"]);
    assert.equal(byTestId("voucher-option-member-credit").querySelector('input[type="checkbox"]').disabled, true);
    assert.equal(view.writes.length, 0);
  } finally { await view.cleanup(); }
});
