import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync } from "node:fs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const bundle = await build({
  entryPoints: ["client/src/components/iedit/PageSeoSuggestionsDialog.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "aliases",
    setup(builder) {
      builder.onResolve({ filter: /^@\// }, (args) => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/seo-dialog-test.cjs`);
compiled.filename = `${process.cwd()}/seo-dialog-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Dialog = compiled.exports.default;
const suggestions = {
  meta_title: "Suggested title", meta_description: "Suggested description",
  seo_title: "Suggested social title", seo_description: "Suggested social description", og_image_url: "",
};
const response = () => ({ ok: true, json: async () => ({ suggestions }) });
async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const patches = [];
  const props = {
    context: { pageId: "page-17", getDesign: () => ({ live: true }) },
    values: { title: "Unsaved title", slug: "unsaved-slug", meta_title: "Existing title" },
    onApply: (patch) => patches.push(patch),
    onClose: () => root.render(null),
  };
  await act(async () => root.render(React.createElement(Dialog, props)));
  return { patches, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function click(label) {
  const button = [...document.querySelectorAll("button")].find((el) => (el.getAttribute("aria-label") || el.textContent.trim()) === label);
  assert.ok(button, `Missing button ${label}`);
  await act(async () => button.click());
}
async function edit(key, value) {
  const input = document.getElementById(`ai-seo-${key}`);
  const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("requests live design; five editable fields apply independently without saving or closing", async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return response(); };
  const fixture = await mount();
  try {
    assert.equal(requests[0].url, "/api/ai-compositions/seo");
    assert.equal(requests[0].options.credentials, "include");
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.design, { live: true });
    assert.equal(body.pageId, "page-17");
    assert.equal(body.title, "Unsaved title");
    assert.equal(body.slug, "unsaved-slug");
    assert.equal(body.values.meta_title, "Existing title");
    assert.equal(document.querySelectorAll('input[id^="ai-seo-"], textarea[id^="ai-seo-"]').length, 5);
    assert.match(document.body.textContent, /No suitable image found/);
    assert.match(document.body.textContent, /Save page settings/);
    assert.deepEqual(fixture.patches, []);
    await click("Apply Meta Title");
    assert.deepEqual(fixture.patches, [{ meta_title: suggestions.meta_title }]);
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.match(document.body.textContent, /Applied to page settings/);
    await edit("meta_title", "Edited");
    assert.doesNotMatch(document.body.textContent, /Applied to page settings/);
    for (const [key, label] of [
      ["meta_title", "Meta Title"], ["meta_description", "Meta Description"],
      ["seo_title", "Social Title"], ["seo_description", "Social Description"],
    ]) {
      await edit(key, `Edited ${key}`);
      await click(`Apply ${label}`);
      assert.deepEqual(fixture.patches.at(-1), { [key]: `Edited ${key}` });
    }
    for (const invalid of ["javascript:alert(1)", "data:image/png,test", "/relative.png", "ftp://example.test/image.png"]) {
      await edit("og_image_url", invalid);
      const count = fixture.patches.length;
      await click("Apply Social Image URL");
      assert.equal(fixture.patches.length, count);
      assert.match(document.querySelector('[role="alert"]').textContent, /https/);
    }
    await edit("og_image_url", "https://example.test/image.png");
    await click("Apply Social Image URL");
    assert.deepEqual(fixture.patches.at(-1), { og_image_url: "https://example.test/image.png" });
    await edit("og_image_url", "");
    await click("Apply Social Image URL");
    assert.deepEqual(fixture.patches.at(-1), { og_image_url: "" });
    await edit("meta_title", "Discard this draft");
    await click("Close");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(fixture.patches.some((patch) => patch.meta_title === "Discard this draft"), false);
    assert.equal(requests.length, 1);
  } finally { await fixture.cleanup(); }
});

test("opens immediately loading; close aborts and ignores late responses", async () => {
  let resolveRequest;
  let signal;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveRequest = resolve; });
  };
  const fixture = await mount();
  try {
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.match(document.body.textContent, /Generating suggestions/);
    await click("Close");
    assert.equal(signal.aborted, true);
    await act(async () => resolveRequest(response()));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(fixture.patches, []);
  } finally { await fixture.cleanup(); }
});

test("shows failure and retries; unmount aborts an in-flight retry", async () => {
  let attempts = 0;
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    attempts++;
    if (attempts === 1) return { ok: false, json: async () => ({ error: 'AI is busy. Please try again.' }) };
    if (attempts === 2) return response();
    return new Promise(() => {});
  };
  let fixture = await mount();
  try {
    assert.match(document.querySelector('[role="alert"]').textContent, /try again/);
    await click("Retry");
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(document.getElementById("ai-seo-meta_title").value, suggestions.meta_title);
  } finally { await fixture.cleanup(); }
  fixture = await mount();
  await fixture.cleanup();
  assert.equal(signal.aborted, true);
});
