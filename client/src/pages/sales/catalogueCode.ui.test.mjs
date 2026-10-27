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
const { MemoryRouter } = await import("react-router-dom");
const built = await build({
  entryPoints: ["client/src/pages/sales/Catalogue.jsx"], bundle: true, write: false,
  packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src` },
  plugins: [{
    name: "isolated-catalogue-data",
    setup(b) {
      b.onResolve({ filter: /^\.\/useCatalogue$/ }, () => ({ path: "catalogue-hooks", namespace: "fixture" }));
      // Product editor requirements are a separate resource; keep this code
      // validation suite isolated from inventory APIs and auth contexts.
      b.onResolve({ filter: /\/useExhibition$/ }, () => ({ path: "exhibition", namespace: "exhibition-fixture" }));
      b.onLoad({ filter: /.*/, namespace: "exhibition-fixture" }, () => ({ contents: "export const useExhibition=()=>({data:{items:[]},isPending:false,isError:false}); export const useExhibitionMutation=()=>({}); export const exhibitionRequest=async()=>({items:[]});" }));
      b.onResolve({ filter: /\/useSalesSettings$/ }, () => ({ path: "settings", namespace: "settings-fixture" }));
      b.onLoad({ filter: /.*/, namespace: "settings-fixture" }, () => ({ contents: "export const useSalesSettings=()=>globalThis.catalogueSettingsFixture; export const useSalesSettingsScope=()=>({scopeKey:'fixture',ready:true});" }));
      b.onResolve({ filter: /\/useMemberAccess$/ }, () => ({ path: "access", namespace: "access-fixture" }));
      b.onLoad({ filter: /.*/, namespace: "access-fixture" }, () => ({ contents: "export const useMemberAccess=()=>({isAccessReady:true,isFeatureExcluded:()=>false});" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const useCatalogueTaxOptions=()=>globalThis.catalogueTaxOptionsFixture||({data:{provider:'xero',items:[{id:'OUTPUT2',name:'VAT',rateBps:2000,selectable:true}]},isPending:false}); export const useCatalogue=(type)=>({data:globalThis.catalogueRowsFixture?.[type]||[],create:{},update:{}}); export const useEventOptions=()=>({});" }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/catalogue-code-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(built.outputFiles[0].text, `${process.cwd()}/catalogue-code-fixture.cjs`);
const { EditDialog: RawEditDialog, CatalogueTable, BundleItems, default: Catalogue } = mod.exports;
const EditDialog = (props) => React.createElement(RawEditDialog, { showInternalCode: true, showSku: true, ...props });
globalThis.catalogueSettingsFixture = { data: { showInternalCode: true, showSku: true }, isPending: false, isError: false };
after(() => dom.window.close());

for (const mode of ["row", "copySource"]) test(`category-first bundle ${mode} preserves identity, order and strict payload`, async () => {
  const products = [{ id: "p1", categoryId: "c1", name: "Delegate ticket" },
    { id: "p2", categoryId: "c2", name: "Delegate ticket" }, { id: "p3", name: "Other" }];
  let saved;
  const select = async (label, value) => act(async () => {
    const control = document.querySelector(`[aria-label="${label}"]`);
    control.value = value;
    control.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  const click = async label => act(async () => document.querySelector(`[aria-label="${label}"]`).click());
  await renderFixture(EditDialog, {
    config: { type: "bundles", [mode]: { id: "bundle", code: "BUNDLE", name: "Bundle", sellingPriceMinor: 100,
      items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 3 }, { productId: "p3", quantity: 1 }] } },
    categories: [{ id: "c1", name: "Conference A" }, { id: "c2", name: "Conference B" }, { id: "empty", name: "Empty" }],
    products, events: {}, onClose() {}, onSave(data) { saved = data; },
  }, async () => {
    const value = label => document.querySelector(`[aria-label="${label}"]`).value;
    assert.equal(value("Included category 1"), "c1");
    assert.equal(value("Included category 2"), "c2");
    assert.equal(value("Included category 3"), "uncategorised");
    assert.deepEqual([...document.querySelector('[aria-label="Included product 1"]').options].map(o => o.value), ["", "p1"]);
    await select("Included category 1", "empty");
    assert.equal(value("Included product 1"), "");
    await submitForm();
    assert.equal(saved, undefined);
    await click("Move item 1 down");
    assert.equal(value("Included category 2"), "empty");
    await select("Included category 2", "c1");
    await select("Included product 2", "p1");
    await click("Remove item 1");
    assert.equal(value("Included category 1"), "c1");
    assert.equal(value("Quantity 1"), "2");
    await submitForm();
    assert.deepEqual(saved.items, [{ productId: "p1", quantity: 2 }, { productId: "p3", quantity: 1 }]);
    assert.ok(saved.items.every(item => Object.keys(item).sort().join() === "productId,quantity"));
  });
});

test("bundle loading and unavailable selections retain saved product IDs until explicit replacement", async () => {
  const items = [{ productId: "old", quantity: 2 }, { productId: "missing", quantity: 3 }];
  const props = { form: { items }, update() { assert.fail("Loading must not mutate saved items"); },
    categories: [], products: [], loading: true };
  await renderFixture(BundleItems, props, async root => {
    assert.equal(document.querySelector('[aria-label="Included product 1"]').value, "old");
    assert.equal(document.querySelector('[aria-label="Included category 1"]').disabled, true);
    await act(async () => root.render(React.createElement(BundleItems, { ...props, loading: false,
      products: [{ id: "old", categoryId: "archived-category", name: "Old", isActive: false }],
      categories: [{ id: "archived-category", name: "Archive", isActive: false }] })));
    assert.equal(document.querySelector('[aria-label="Included category 1"]').value, "archived-category");
    assert.match(document.querySelector('[aria-label="Included category 1"]').textContent, /Archive \(archived\)/);
    assert.equal(document.querySelector('[aria-label="Included product 2"]').value, "missing");
    assert.equal(items[0].productId, "old");
  });
});

test("bundle summary distinguishes duplicate names by category", async () => {
  await renderFixture(CatalogueTable, { type: "bundles", rows: [{ id: "bundle", name: "Bundle",
    items: [{ productId: "one", quantity: 2 }, { productId: "two", quantity: 3 }] }],
    products: [{ id: "one", name: "Delegate", categoryId: "a" }, { id: "two", name: "Delegate", categoryId: "b" }],
    categories: [{ id: "a", name: "Conference A" }, { id: "b", name: "Conference B" }] }, async () => {
    assert.match(document.body.textContent, /2 × Conference A — Delegate · 3 × Conference B — Delegate/);
  });
});

test("agreement renders qualified frozen/public/preview components and escapes category text", async () => {
  const output = await build({ entryPoints: ["client/src/components/sales/AgreementDocument.jsx"],
    bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
    alias: { "@": `${process.cwd()}/client/src` } });
  const documentModule = new Module(`${process.cwd()}/agreement-category-fixture.cjs`);
  documentModule.paths = Module._nodeModulePaths(process.cwd());
  documentModule._compile(output.outputFiles[0].text, `${process.cwd()}/agreement-category-fixture.cjs`);
  const components = [{ quantity: 2, product_snapshot: { name: "Delegate", categoryName: "<img src=x> Conference A" } },
    { quantity: 1, product_snapshot: { name: "Legacy" } }];
  for (const shape of ["sales_quote_bundle_component", "components", "bundleComponents"]) {
    const value = shape === "bundleComponents" ? components.map(c => ({ ...c.product_snapshot, quantity: c.quantity })) : components;
    await renderFixture(documentModule.exports.default, { quote: { currency: "GBP", lines: [
      { description: "Package", quantity: 1, [shape]: value }] } }, async () => {
      assert.match(document.body.textContent, /2 × <img src=x> Conference A — Delegate/);
      assert.match(document.body.textContent, /1 × Legacy/);
      assert.equal(document.querySelector('img[src="x"]'), null);
    });
  }
});

async function renderFixture(Component, props, check) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const wrappedRoot = { render(element) { root.render(React.createElement(MemoryRouter, null, element)); } };
  await act(async () => wrappedRoot.render(React.createElement(Component, props)));
  try { await check(wrappedRoot); } finally { await act(async () => root.unmount()); host.remove(); }
}
const submitForm = async () => act(async () => document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
const enterInput = async (label, value) => act(async () => {
  const input = document.querySelector(`[aria-label="${label}"]`);
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});

const defaultCode = { provider: "xero", id: "DEFAULT-PRIVATE", name: "Standard sales VAT", rateBps: 2000, selectable: true };
const overrideCode = { provider: "xero", id: "OVERRIDE-PRIVATE", name: "Zero rated sales", rateBps: 0, selectable: true };
const defaultTaxOptions = () => ({ isPending: false, isError: false, data: { provider: "xero", items: [defaultCode, overrideCode], defaultProductTaxCode: defaultCode, defaultProductTaxCodeUnavailable: false } });
const chooseTax = async (code) => act(async () => {
  const select = document.querySelector('[aria-label="Synced VAT code"]');
  select.value = code ? JSON.stringify([code.provider, code.id]) : "";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
});

for (const mode of ["new", "edit", "copy", "legacy-copy"]) {
  test(`${mode} product uses default only for new products; natural labels and explicit overrides survive refresh`, async () => {
    globalThis.catalogueTaxOptionsFixture = defaultTaxOptions();
    const source = { id: "source", name: "Workshop", standardPriceMinor: 29, taxRateBps: 0, ...(mode !== "legacy-copy" ? { taxCode: overrideCode } : {}) };
    const props = { config: { type: "products", ...(mode === "edit" ? { row: source } : mode.includes("copy") ? { copySource: source } : {}) }, categories: [], products: [], events: {}, onClose() {}, showInternalCode: false, onSave(data) { saved.push(data); } };
    const saved = [];
    try {
      await renderFixture(RawEditDialog, props, async root => {
        const select = () => document.querySelector('[aria-label="Synced VAT code"]');
        assert.equal(select().value, mode === "new" ? JSON.stringify(["xero", defaultCode.id]) : mode === "copy" ? JSON.stringify(["xero", overrideCode.id]) : "");
        assert.equal([...select().options].find(option => option.value === JSON.stringify(["xero", defaultCode.id])).textContent, "Standard sales VAT");
        assert.equal([...select().options].find(option => option.value === JSON.stringify(["xero", overrideCode.id])).textContent, "Zero rated sales");
        assert.equal(select().textContent.includes("PRIVATE"), false);
        assert.equal(select().textContent.includes("xero"), false);
        if (mode === "new") await enterInput("Standard price", "0.29");
        if (mode === "legacy-copy") {
          await submitForm();
          assert.equal(saved.length, 0, "copy cannot silently inherit the global default");
        } else {
          await submitForm();
          if (mode === "edit") assert.equal("taxCode" in saved[0], false);
          else assert.deepEqual(saved[0].taxCode, { provider: "xero", id: mode === "new" ? defaultCode.id : overrideCode.id });
        }
        await chooseTax(overrideCode);
        globalThis.catalogueTaxOptionsFixture = defaultTaxOptions();
        await act(async () => root.render(React.createElement(RawEditDialog, props)));
        assert.equal(select().value, JSON.stringify(["xero", overrideCode.id]));
        await submitForm();
        assert.deepEqual(saved.at(-1).taxCode, { provider: "xero", id: overrideCode.id });
        await chooseTax(null);
        globalThis.catalogueTaxOptionsFixture = defaultTaxOptions();
        await act(async () => root.render(React.createElement(RawEditDialog, props)));
        assert.equal(select().value, "", "refresh must not restore default after user clears it");
      });
    } finally { delete globalThis.catalogueTaxOptionsFixture; }
  });
}

for (const unavailable of [false, true]) {
  test(`new product waits for options and initializes once; unavailable default ${unavailable}`, async () => {
    globalThis.catalogueTaxOptionsFixture = { isPending: true };
    const props = { config: { type: "products" }, categories: [], products: [], events: {}, onClose() {}, onSave() {} };
    try {
      await renderFixture(RawEditDialog, props, async root => {
        const select = () => document.querySelector('[aria-label="Synced VAT code"]');
        assert.equal(select().value, "");
        globalThis.catalogueTaxOptionsFixture = defaultTaxOptions();
        globalThis.catalogueTaxOptionsFixture.data.defaultProductTaxCodeUnavailable = unavailable;
        await act(async () => root.render(React.createElement(RawEditDialog, props)));
        assert.equal(select().value, unavailable ? "" : JSON.stringify(["xero", defaultCode.id]));
        globalThis.catalogueTaxOptionsFixture = defaultTaxOptions();
        globalThis.catalogueTaxOptionsFixture.data.defaultProductTaxCode = overrideCode;
        await act(async () => root.render(React.createElement(RawEditDialog, props)));
        assert.equal(select().value, unavailable ? "" : JSON.stringify(["xero", defaultCode.id]));
      });
    } finally { delete globalThis.catalogueTaxOptionsFixture; }
  });
}

for (const showInternalCode of [false, true]) for (const showSku of [false, true]) {
  for (const mode of ["create", "edit", "copy"]) {
    test(`identifier visibility ${showInternalCode}/${showSku} ${mode}: fields and payload`, async () => {
      const source = { id: "source", name: "Workshop", code: "SOURCE", sku: "SOURCE-SKU", standardPriceMinor: 29, minimumPriceMinor: null, costMinor: 0, capacityMetadata: { keep: true }, taxCode: { provider: "xero", id: "OUTPUT2" } };
      const saved = [];
      await renderFixture(RawEditDialog, {
        config: { type: "products", ...(mode === "edit" ? { row: source } : mode === "copy" ? { copySource: source } : {}) },
        showInternalCode, showSku, categories: [], products: [], events: {}, onClose() {}, onSave(data) { saved.push(data); },
      }, async () => {
        assert.equal(Boolean(document.querySelector('[aria-label="Internal code"]')), showInternalCode);
        assert.equal(Boolean(document.querySelector('[aria-label="SKU"]')), showSku);
        if (mode === "create") {
          if (showInternalCode) await enterInput("Internal code", "NEW");
          await enterInput("Standard price", "0.29");
          await act(async () => {
            const tax = document.querySelector('[aria-label="Synced VAT code"]');
            tax.value = JSON.stringify(["xero", "OUTPUT2"]);
            tax.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
          });
        }
        if (mode === "copy") {
          assert.equal(document.querySelector('[aria-label="Name"]').value, "Workshop (copy)");
          assert.equal(document.querySelector('[aria-label="Synced VAT code"]').value, JSON.stringify(["xero", "OUTPUT2"]));
          if (showSku) assert.equal(document.querySelector('[aria-label="SKU"]').value, "");
          if (showInternalCode) assert.notEqual(document.querySelector('[aria-label="Internal code"]').value, source.code);
        }
        await submitForm();
        assert.equal(saved.length, 1);
        assert.equal("code" in saved[0], showInternalCode);
        assert.equal("sku" in saved[0], showSku);
        assert.equal(saved[0].standardPriceMinor, 29);
        assert.equal(saved[0].id, undefined);
        if (mode === "copy") {
          assert.deepEqual(saved[0].taxCode, source.taxCode);
          assert.deepEqual(saved[0].capacityMetadata, { keep: true });
          if (showSku) assert.equal(saved[0].sku, null);
        }
      });
    });
  }
  for (const type of ["products", "bundles"]) {
    test(`table ${type} visibility ${showInternalCode}/${showSku} and permission`, async () => {
      const row = { id: "source", name: "Workshop", code: "PRIVATE-CODE", sku: "PRIVATE-SKU", standardPriceMinor: 29, sellingPriceMinor: 29 };
      const copies = [];
      const props = { type, rows: [row], products: [], categories: [], showInternalCode, showSku, canManage: true, onDuplicate: item => copies.push(item), onEdit() {}, onArchive() {} };
      await renderFixture(CatalogueTable, props, async root => {
        assert.equal(document.body.textContent.includes(row.code), showInternalCode);
        assert.equal(document.body.textContent.includes(row.sku), type === "products" && showSku);
        await act(async () => document.querySelector('[aria-label="Duplicate Workshop"]').click());
        assert.equal(copies[0], row);
        await act(async () => root.render(React.createElement(CatalogueTable, { ...props, canManage: false })));
        assert.equal(document.querySelector('[aria-label="Duplicate Workshop"]'), null);
        assert.equal(document.querySelector('[aria-label="Edit Workshop"]'), null);
      });
    });
  }
  test(`bundle copy visibility ${showInternalCode}/${showSku} saves a fresh create payload`, async () => {
    const saved = [];
    await renderFixture(RawEditDialog, {
      config: { type: "bundles", copySource: { id: "source", name: "Bundle", code: "SOURCE", sku: "NOT-A-BUNDLE-FIELD", sellingPriceMinor: 29, minimumPriceMinor: 0, presentationMode: "itemised", items: [{ productId: "missing", quantity: 3 }, { productId: "active", quantity: 2 }], archivedAt: "yesterday" } },
      showInternalCode, showSku, categories: [], products: [], events: {}, onClose() {}, onSave(data) { saved.push(data); },
    }, async () => {
      assert.equal(Boolean(document.querySelector('[aria-label="Internal code"]')), showInternalCode);
      assert.equal(document.querySelector('[aria-label="SKU"]'), null);
      await submitForm();
      assert.equal(saved.length, 1);
      assert.equal("code" in saved[0], showInternalCode);
      if (showInternalCode) assert.notEqual(saved[0].code, "SOURCE");
      assert.equal(saved[0].sellingPriceMinor, 29);
      assert.equal(saved[0].minimumPriceMinor, 0);
      assert.equal(saved[0].presentationMode, "itemised");
      assert.deepEqual(saved[0].items, [{ productId: "missing", quantity: 3 }, { productId: "active", quantity: 2 }]);
      for (const key of ["id", "sku", "archivedAt"]) assert.equal(key in saved[0], false);
    });
  });
}

test("copy cancellation performs no save; reopening starts fresh", async () => {
  let closes = 0; let saves = 0;
  const source = { name: "Source", code: "SOURCE", standardPriceMinor: 29 };
  const props = { config: { type: "products", copySource: source }, categories: [], products: [], events: {}, onClose() { closes++; }, onSave() { saves++; } };
  await renderFixture(EditDialog, props, async root => {
    const firstCode = document.querySelector('[aria-label="Internal code"]').value;
    await enterInput("Name", "Changed copy");
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Cancel").click());
    assert.equal(closes, 1);
    assert.equal(saves, 0);
    await act(async () => root.render(React.createElement(EditDialog, { ...props, config: null })));
    await act(async () => root.render(React.createElement(EditDialog, { ...props, config: { type: "products", copySource: source } })));
    assert.equal(document.querySelector('[aria-label="Name"]').value, "Source (copy)");
    assert.notEqual(document.querySelector('[aria-label="Internal code"]').value, firstCode);
  });
});

test("copy with legacy/unavailable tax cannot retain source tax", async () => {
  await renderFixture(EditDialog, {
    config: { type: "products", copySource: { name: "Legacy", code: "LEGACY", standardPriceMinor: 29, taxRateBps: 0, taxCode: { provider: "xero", id: "UNAVAILABLE" } } },
    categories: [], products: [], events: {}, onClose() {}, onSave() { assert.fail("must require new tax"); },
  }, async () => {
    assert.equal(document.querySelector('[aria-label="Synced VAT code"]').value, "");
    assert.equal(document.body.textContent.includes("Keep saved"), false);
    await submitForm();
    assert.match(document.querySelector('[role="alert"]').textContent, /Select a synced provider VAT code/);
  });
});

test("synchronous guard blocks duplicate submits until async save settles; failure retains form and allows retry", async () => {
  let calls = 0; let reject;
  await renderFixture(EditDialog, {
    config: { type: "bundles", copySource: { name: "Bundle", code: "SOURCE", sellingPriceMinor: 29, items: [{ productId: "missing", quantity: 3 }, { productId: "active", quantity: 2 }] } },
    categories: [], products: [{ id: "active", name: "Available" }], events: {}, onClose() {},
    onSave() { calls++; return new Promise((_, fail) => { reject = fail; }); },
  }, async () => {
    assert.match(document.querySelector('[aria-label="Included product 1"]').textContent, /Unavailable product/);
    const form = document.querySelector("form");
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(calls, 1);
    await act(async () => reject(new Error("Fixture save rejected")));
    assert.match(document.querySelector('[role="alert"]').textContent, /Fixture save rejected/);
    assert.equal(document.querySelector('[aria-label="Selling price"]').value, "0.29");
    await submitForm();
    assert.equal(calls, 2);
    await act(async () => reject(new Error("Retry rejected")));
  });
});

test("non-category catalogue fails closed while settings load or fail", async () => {
  globalThis.catalogueSettingsFixture = { isPending: true };
  try {
    await renderFixture(Catalogue, { section: "products" }, async root => {
      assert.equal(document.body.textContent.includes("New product"), false);
      globalThis.catalogueSettingsFixture = { isError: true, refetch() {} };
      await act(async () => root.render(React.createElement(Catalogue, { section: "products" })));
      assert.match(document.body.textContent, /Sales settings could not be loaded/);
      assert.equal(document.body.textContent.includes("New product"), false);
    });
  } finally {
    globalThis.catalogueSettingsFixture = { data: { showInternalCode: true, showSku: true }, isPending: false, isError: false };
  }
});

for (const action of ["new", "edit", "copy"]) {
  test(`tenant scope change closes ${action} dialog and clears search before reopening`, async () => {
    const settings = { data: { showInternalCode: true, showSku: true }, isPending: false, isError: false, scopeKey: "tenant-a" };
    globalThis.catalogueSettingsFixture = settings;
    globalThis.catalogueRowsFixture = { products: [{ id: "source", name: "Old tenant product", code: "OLD_TENANT", standardPriceMinor: 29 }] };
    try {
      await renderFixture(Catalogue, { section: "products" }, async root => {
        await act(async () => {
          const search = document.querySelector('[placeholder="Search products"]');
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(search, "Old search");
          search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
        await act(async () => {
          const trigger = action === "new" ? [...document.querySelectorAll("button")].find(button => button.textContent === "New product") : document.querySelector(`[aria-label="${action === "edit" ? "Edit" : "Duplicate"} Old tenant product"]`);
          trigger.click();
        });
        assert.ok(document.querySelector('[role="dialog"]'));
        globalThis.catalogueSettingsFixture = { ...settings, scopeKey: "tenant-b" };
        globalThis.catalogueRowsFixture = { products: [] };
        await act(async () => root.render(React.createElement(Catalogue, { section: "products" })));
        assert.equal(document.querySelector('[role="dialog"]'), null);
        assert.equal(document.querySelector('[placeholder="Search products"]').value, "");
        await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "New product").click());
        assert.equal(document.querySelector('[aria-label="Name"]').value, "");
        assert.equal(document.querySelector('[aria-label="Internal code"]').value, "");
      });
    } finally {
      globalThis.catalogueRowsFixture = undefined;
      globalThis.catalogueSettingsFixture = { data: { showInternalCode: true, showSku: true }, isPending: false, isError: false };
    }
  });
}

for (const eventReference of [{ kind: "complex" }, { eventId: "event" }, { ticketTypeId: "ticket" }, { kind: "complex", eventId: "event" }]) {
  test(`partial copied event link ${JSON.stringify(eventReference)} requires correction or removal`, async () => {
    const saved = [];
    await renderFixture(EditDialog, {
      config: { type: "products", copySource: { name: "Partial event", code: "PARTIAL", standardPriceMinor: 29, eventReference, taxCode: { provider: "xero", id: "OUTPUT2" } } },
      categories: [], products: [], events: {}, onClose() {}, onSave(data) { saved.push(data); },
    }, async () => {
      await submitForm();
      assert.equal(saved.length, 0);
      assert.match(document.querySelector('[role="alert"]').textContent, /Complete the event and ticket type selection, or remove the event link/);
      await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Remove event link").click());
      await submitForm();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].eventReference, null);
    });
  });
}

for (const initial of [undefined, false, true]) {
  test(`product automation preserves ${initial ?? "legacy default"} and submits a boolean on edit`, async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); const saved = [];
    await act(async () => root.render(React.createElement(EditDialog, {
      config: { type: "products", row: { id: "product", name: "Workshop", code: "WORKSHOP", standardPriceMinor: 12500, createTaskOnAcceptance: initial } },
      categories: [], products: [], events: {}, onClose() {}, onSave(data) { saved.push(data); },
    })));
    try {
      const checkbox = document.querySelector("#product-create-task-on-acceptance");
      const form = checkbox.closest("form");
      assert.equal(checkbox.checked, Boolean(initial));
      const submit = async () => act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
      await submit();
      assert.equal(saved[0].createTaskOnAcceptance, Boolean(initial));
      await act(async () => checkbox.click());
      await submit();
      assert.equal(saved[1].createTaskOnAcceptance, !Boolean(initial));
      assert.match(document.querySelector("#product-task-acceptance-help").textContent, /fixed with the issued quote/);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
}

test("new product automation defaults off and saves opt-in; bundle forms have no toggle", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const saved = [];
  const props = { categories: [], products: [], events: {}, onClose() {}, onSave(data) { saved.push(data); } };
  await act(async () => root.render(React.createElement(EditDialog, { ...props, config: { type: "products" } })));
  try {
    const checkbox = document.querySelector("#product-create-task-on-acceptance");
    assert.equal(checkbox.checked, false);
    const form = checkbox.closest("form");
    const input = async (element, value) => act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await input(form.querySelector('[aria-label="Internal code"]'), "WORKSHOP");
    await input(form.querySelector('[aria-label="Standard price"]'), "125.00");
    await act(async () => {
      const tax = form.querySelector('[aria-label="Synced VAT code"]');
      tax.value = JSON.stringify(["xero", "OUTPUT2"]);
      tax.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(saved[0].createTaskOnAcceptance, false);
    await act(async () => checkbox.click());
    await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(saved[1].createTaskOnAcceptance, true);
    await act(async () => root.render(React.createElement(EditDialog, { ...props, config: { type: "bundles" } })));
    assert.equal(document.querySelector("#product-create-task-on-acceptance"), null);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

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
