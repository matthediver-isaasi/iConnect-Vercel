import assert from "node:assert/strict";
import { test, after } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "CustomEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const built = await build({
  entryPoints: ["client/src/pages/sales/Catalogue.jsx"], bundle: true, write: false,
  packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{
    name: "isolated-catalogue-data",
    setup(b) {
      b.onResolve({ filter: /^\.\/useCatalogue$/ }, () => ({ path: "catalogue-hooks", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const useCatalogueTaxOptions=()=>({data:[],isPending:false}); export const useCatalogue=()=>({}); export const useEventOptions=()=>({});" }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/catalogue-code-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(built.outputFiles[0].text, `${process.cwd()}/catalogue-code-fixture.cjs`);
const { EditDialog } = mod.exports;
after(() => dom.window.close());

for (const type of ["bundles", "products"]) for (const editing of [false, true]) {
  test(`${type}: ${editing ? "edit" : "create"} validates codes before any save`, async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); const saved = [];
    await act(async () => root.render(React.createElement(EditDialog, {
      config: { type, ...(editing ? { row: { id: "saved", name: "Existing", code: "EXISTING" } } : {}) },
      categories: [], products: [], events: {}, onClose() {}, onSave(data) { saved.push(data); },
    })));
    try {
      const input = document.querySelector('[aria-label="Internal code"]');
      const form = input.closest("form");
      const save = form.querySelector('button[type="submit"]');
      const enter = async value => act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      if (editing) assert.equal(input.value, "EXISTING", "existing code is preserved on opening");
      assert.equal(input.maxLength, 64);
      for (const invalid of ["", "LC Platinum", "LC/PLATINUM", "-PLATINUM", "_PLATINUM", "ÉVENT", "A".repeat(65)]) {
        await enter(invalid);
        assert.equal(input.getAttribute("aria-invalid"), "true", invalid);
        assert.equal(save.disabled, true, invalid);
        assert.ok(document.querySelector("#internal-code-error"));
        await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
        assert.equal(saved.length, 0, "invalid code cannot bypass disabled button through submit");
      }
      await enter("LC-Platinum");
      assert.equal(input.value, "LC-PLATINUM");
      assert.equal(input.getAttribute("aria-invalid"), "false");
      assert.equal(save.disabled, false);
      assert.equal(document.querySelector("#internal-code-error"), null);
      if (type === "bundles") {
        await act(async () => {
          const price = form.querySelector('[aria-label="Selling price"]');
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(price, "125.00");
          price.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
        await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
        assert.equal(saved[0].code, "LC-PLATINUM");
        assert.equal(saved[0].sellingPriceMinor, 12500);
      }
      await enter("A".repeat(64));
      assert.equal(save.disabled, false);
    } finally {
      await act(async () => root.unmount()); host.remove();
    }
  });
}

test("editing bundle prices preserves stored amounts and blocks invalid currency input", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const saved = [];
  await act(async () => root.render(React.createElement(EditDialog, {
    config: { type: "bundles", row: { id: "bundle", code: "BUNDLE", name: "Bundle", sellingPriceMinor: 12500, minimumPriceMinor: 10050 } },
    categories: [], products: [], events: {}, onClose() {}, onSave(data) { saved.push(data); },
  })));
  try {
    const price = document.querySelector('[aria-label="Selling price"]');
    const minimum = document.querySelector('[aria-label="Minimum price"]');
    const form = price.closest("form");
    assert.equal(price.value, "125.00");
    assert.equal(minimum.value, "100.50");
    assert.equal(price.inputMode, "decimal");
    const submit = async () => act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    const input = async (element, value) => act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await submit();
    assert.equal(saved[0].sellingPriceMinor, 12500);
    assert.equal(saved[0].minimumPriceMinor, 10050);
    for (const invalid of ["", "-1", "1.234", "1e3", "abc", "90071992547409.92", "99"]) {
      await input(price, invalid); await submit();
      assert.equal(saved.length, 1);
      assert.ok(form.querySelector('[role="alert"]'));
    }
    await input(minimum, "");
    await input(price, "0.29");
    await submit();
    assert.equal(saved[1].sellingPriceMinor, 29);
    assert.equal(saved[1].minimumPriceMinor, null);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
