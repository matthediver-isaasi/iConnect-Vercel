import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DocumentFragment", "MutationObserver", "Event", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

const built = await build({
  stdin: { resolveDir: process.cwd(), contents: 'export { LinesEditor } from "./client/src/components/sales/QuotesWorkspace.jsx";', loader: "js" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{
    name: "isolated-quote-tax",
    setup(builder) {
      builder.onResolve({ filter: /hooks\/useSalesSettings$/ }, () => ({ path: "naming", namespace: "fixture" }));
      builder.onResolve({ filter: /pages\/sales\/useCatalogue$/ }, () => ({ path: "tax", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path === "naming"
          ? 'export const useQuoteNaming=()=>({singular:"Quote",plural:"Quotes",slug:"quotes"});'
          : "export const useCatalogueTaxOptions=()=>({data:globalThis.quoteTaxFixture,isPending:false,isError:false});",
        loader: "js",
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/quote-tax-labels-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(built.outputFiles[0].text, `${process.cwd()}/quote-tax-labels-fixture.cjs`);

test("quote VAT options show only natural names and preserve identity when overridden", async () => {
  const standard = { provider: "xero", id: "PRIVATE-OUTPUT", name: "Standard sales VAT", rateBps: 2000, selectable: true };
  const zero = { provider: "xero", id: "PRIVATE-ZERO", name: "Zero rated sales", rateBps: 0, selectable: true };
  globalThis.quoteTaxFixture = { provider: "xero", items: [standard, zero, { id: "UNNAMED", rateBps: 725, selectable: false }] };
  let current;
  function Fixture() {
    const [form, setForm] = React.useState({ currency: "GBP", lines: [{
      key: "line", type: "free_text", description: "Workshop", quantity: 1,
      standardUnitPriceMinor: 1200, quotedUnitPriceMinor: 1200, discountBps: 0,
      taxCode: standard, taxRateBps: 2000,
    }] });
    current = form;
    return React.createElement(mod.exports.LinesEditor, { form, setForm, products: [], bundles: [], readOnly: false, canOverride: true });
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Fixture)));
    const select = host.querySelector('[aria-label="Line 1 provider VAT code"]');
    assert.deepEqual([...select.options].map(option => option.textContent), ["Standard sales VAT", "Standard sales VAT", "Zero rated sales", "VAT code unavailable"]);
    assert.equal(select.options[3].disabled, true);
    await act(async () => {
      select.value = JSON.stringify(["xero", zero.id]);
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(current.lines[0].taxCode.id, zero.id);
    assert.equal(current.lines[0].taxRateBps, 0);
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(current.lines[0].taxCode.id, standard.id);
    assert.equal(current.lines[0].taxRateBps, 2000);
  } finally {
    await act(async () => root.unmount());
    host.remove(); delete globalThis.quoteTaxFixture;
  }
});
