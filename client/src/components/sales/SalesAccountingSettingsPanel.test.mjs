import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test/sales/settings" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider } = require("@tanstack/react-query");
const { MemoryRouter } = require("react-router-dom");
after(() => dom.window.close());

const built = await build({
  entryPoints: ["client/src/components/sales/SalesAccountingSettingsPanel.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{
    name: "isolated-naming",
    setup(build) {
      build.onResolve({ filter: /^@\/hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'export const useQuoteNaming = () => globalThis.accountingPanelNaming;',
        loader: "js",
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/accounting-settings-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(built.outputFiles[0].text, `${process.cwd()}/accounting-settings-fixture.cjs`);
const Panel = mod.exports.default;

for (const naming of [
  { singular: "Quote", plural: "Quotes", slug: "quotes" },
  { singular: "Proposal", plural: "Proposals", slug: "proposals" },
]) {
  test(`accounting panel uses ${naming.singular} terminology without changing invoice or provider concepts`, async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => { fetches += 1; throw new Error("Unexpected network request in isolated panel test"); };
    globalThis.accountingPanelNaming = naming;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
    client.setQueryData(["sales-accounting-configuration", "selected-sale"], {
      activeProvider: "quickbooks",
      isReady: false,
      missing: ["quickbooks_sales_item"],
      requiredTaxRates: [2000],
      mappings: { 2000: "VAT20" },
      quickbooksSalesItemId: "sales-item",
      availableTaxCodes: [{ id: "VAT20", name: "VAT 20" }],
      availableItems: [{ id: "sales-item", name: "Quote delivery revenue" }],
    });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(QueryClientProvider, { client },
        React.createElement(MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
          React.createElement(Panel, { saleId: "selected-sale" })))));
      assert.ok(host.textContent.includes(`products and ${naming.singular.toLowerCase()} lines`));
      assert.ok(host.textContent.includes(`sale’s accepted ${naming.singular.toLowerCase()} only`));
      assert.match(host.textContent, /New transactions do not need percentage mappings/);
      assert.match(host.textContent, /Lines with saved provider codes use those codes directly/);
      assert.match(host.textContent, /before creating invoices/);
      assert.match(host.textContent, /QuickBooks sales item used for invoice lines/);
      assert.match(host.textContent, /Quote delivery revenue/);
      assert.match(host.textContent, /Legacy tax rate 20%/);
      assert.match(host.textContent, /Accounting configuration/);
      assert.equal(fetches, 0);
    } finally {
      await act(async () => root.unmount());
      client.clear(); host.remove();
      globalThis.fetch = originalFetch;
      delete globalThis.accountingPanelNaming;
    }
  });
}
