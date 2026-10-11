import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
const result = await build({ entryPoints: ["client/src/components/sales/OpportunitiesWorkspace.jsx"], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", loader: { ".css": "empty" }, alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{ name: "unrelated-page-dependencies", setup(b) {
    b.onResolve({ filter: /\/(base44Client|useMemberAccess|OpportunityProjectTasksPanel)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const base44 = {}; export const getActiveTenantId = () => 'fixture'; export const subscribeToActiveTenantId = () => () => {}; export const useMemberAccess = () => ({}); export default () => null;", loader: "js" }));
  } }],
});
const mod = new Module(`${process.cwd()}/contact-panel-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, mod.filename || `${process.cwd()}/contact-panel-fixture.cjs`);
const React = mod.require("react");
globalThis.React = React;
const { renderToString } = mod.require("react-dom/server");
const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");
test("contacts panel distinguishes loading, no organisation, empty and already assigned contacts", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (props = {}) => renderToString(React.createElement(QueryClientProvider, { client },
    React.createElement(mod.exports.CollectionPanel, { type: "contacts", opportunityId: "opp", organizationId: "org", items: [], canEdit: true, onChanged() {}, ...props })));
  assert.match(render(), /Loading organisation contacts/);
  assert.match(render({ organizationId: null }), /No organisation is linked/);
  client.setQueryData(["opportunity-contact-options", "org"], []);
  assert.match(render(), /No contacts were found/);
  client.setQueryData(["opportunity-contact-options", "org"], [{ id: "person", first_name: "Example", organization_id: "org" }]);
  assert.match(render(), /Select existing organisation contact/);
  assert.match(render({ items: [{ id: "role-row", member_id: "person" }] }), /All organisation contacts are already added/);
  assert.doesNotMatch(render({ organizationId: "other-org" }), /All organisation contacts are already added/);
  client.getQueryCache().find({ queryKey: ["opportunity-contact-options", "org"], exact: true })
    .setState({ status: "error", error: new Error("Contact lookup failed") });
  assert.match(render(), /Contact lookup failed/);
  assert.match(render(), /Retry/);
  assert.doesNotMatch(render({ canEdit: false }), /Organisation contact/);
  client.clear();
});
