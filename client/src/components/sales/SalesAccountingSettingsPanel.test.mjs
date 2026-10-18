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
      build.onResolve({ filter: /^@\/components\/ui\/select$/ }, () => ({ path: "select", namespace: "select-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "select-fixture" }, () => ({
        contents: `import React from "react";
          export const SelectTrigger = () => null;
          export const SelectValue = () => null;
          export const SelectContent = ({children}) => React.createElement(React.Fragment, null, children);
          export const SelectItem = ({value, disabled, children}) => React.createElement("option", {value, disabled}, children);
          export const Select = ({value, onValueChange, children}) => {
            const nodes = React.Children.toArray(children);
            const trigger = nodes.find(node => node.type === SelectTrigger);
            return React.createElement("select", {value, "aria-label":trigger?.props["aria-label"], onChange:e=>onValueChange(e.target.value)},
              nodes.filter(node=>node.type !== SelectTrigger));
          };`,
        loader: "js", resolveDir: process.cwd(),
      }));
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

for (const unavailable of [false, true]) {
  test(`default VAT settings save, clear and invalidate catalogue options; unavailable ${unavailable}`, async () => {
    globalThis.accountingPanelNaming = { singular: "Quote", plural: "Quotes", slug: "quotes" };
    const originalFetch = globalThis.fetch;
    const code = { provider: "xero", id: "PRIVATE-OUTPUT", name: "Standard sales VAT", rateBps: 2000, selectable: true };
    let configuration = {
      activeProvider: "xero", isReady: true, mappings: { 0: "LEGACY-ZERO" }, requiredTaxRates: [],
      productTaxOptions: { provider: "xero", items: [code, { id: "DISABLED", name: "Archived VAT", selectable: false }] },
      defaultProductTaxCode: unavailable ? null : code, defaultProductTaxCodeUnavailable: unavailable,
    };
    const patches = [];
    globalThis.fetch = async (_url, options) => {
      if (options?.method === "PATCH") {
        const patch = JSON.parse(options.body);
        patches.push(patch);
        if ("defaultProductTaxCode" in patch) configuration = { ...configuration, defaultProductTaxCode: patch.defaultProductTaxCode ? code : null, defaultProductTaxCodeUnavailable: false };
      }
      return { ok: true, status: 200, json: async () => configuration };
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
    client.setQueryData(["sales-accounting-configuration", null], configuration);
    client.setQueryData(["sales-catalogue", "tax-options", "tenant"], { items: [] });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const save = async () => act(async () => {
      [...host.querySelectorAll("button")].find(button => button.textContent === "Save accounting configuration").click();
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    const choose = async key => act(async () => {
      const select = host.querySelector('[aria-label="Default product VAT code"]');
      select.value = key;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    try {
      await act(async () => root.render(React.createElement(QueryClientProvider, { client },
        React.createElement(MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, React.createElement(Panel)))));
      const select = host.querySelector('[aria-label="Default product VAT code"]');
      assert.ok(select);
      assert.equal(select.value, unavailable ? "unavailable" : JSON.stringify(["xero", code.id]));
      assert.equal(select.textContent.includes("PRIVATE-OUTPUT"), false);
      assert.equal(select.textContent.includes("xero"), false);
      assert.ok([...select.options].find(option => option.textContent === "Archived VAT").disabled);
      if (unavailable) assert.match(host.textContent, /saved default VAT code is unavailable/);
      await save();
      assert.deepEqual(patches[0], { mappings: [{ taxRateBps: 0, providerTaxCodeId: "LEGACY-ZERO" }] });
      assert.equal(client.getQueryState(["sales-catalogue", "tax-options", "tenant"]).isInvalidated, true);
      await choose(JSON.stringify(["xero", code.id]));
      await save();
      assert.deepEqual(patches[1].defaultProductTaxCode, { provider: "xero", id: code.id });
      assert.deepEqual(patches[1].mappings, patches[0].mappings);
      await choose("none");
      await save();
      assert.equal(patches[2].defaultProductTaxCode, null);
    } finally {
      await act(async () => root.unmount());
      client.clear(); host.remove();
      globalThis.fetch = originalFetch;
      delete globalThis.accountingPanelNaming;
    }
  });
}
