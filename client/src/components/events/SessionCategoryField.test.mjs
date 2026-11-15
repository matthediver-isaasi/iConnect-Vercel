import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync } from "node:fs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

const bundle = await build({
  stdin: { contents: `
    export {default as Field} from "@/components/events/SessionCategoryField";
    export {default as Badges} from "@/components/events/SessionCategoryBadges";
  `, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "local-alias",
    setup(builder) {
      builder.onResolve({ filter: /^@\// }, args => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/session-category-fixtures.cjs`);
compiled.filename = `${process.cwd()}/session-category-fixtures.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { Field, Badges } = compiled.exports;

async function mount(Component, props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = next => act(async () => root.render(React.createElement(Component, next)));
  await render(props);
  return { host, render, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("failed catalogue retains selections, supports removal and retry, then recovers labels", async () => {
  let changed;
  let retries = 0;
  const props = { value: ["saved", "missing"], onChange: ids => { changed = ids; }, query: { isError: true, refetch() { retries++; } } };
  const fixture = await mount(Field, props);
  try {
    assert.match(fixture.host.textContent, /Saved assignments have been kept/);
    const remove = fixture.host.querySelector('[aria-label="Remove Saved category"]');
    assert.ok(remove);
    await act(async () => remove.click());
    assert.deepEqual(changed, ["missing"]);
    const retry = [...fixture.host.querySelectorAll("button")].find(button => button.textContent.includes("Retry"));
    await act(async () => retry.click());
    assert.equal(retries, 1);
    await fixture.render({ ...props, query: { data: [{ id: "saved", name: "Clinical practice" }], isError: false } });
    assert.ok(fixture.host.querySelector('[aria-label="Remove Unavailable category"]'));
    const checkbox = fixture.host.querySelector('input[type="checkbox"]');
    assert.equal(checkbox.checked, true);
    await act(async () => checkbox.click());
    assert.deepEqual(changed, ["missing"]);
  } finally { await fixture.cleanup(); }
});

test("loading and empty catalogue states are explicit and do not change IDs", async () => {
  let mutations = 0;
  const props = { value: ["saved"], onChange() { mutations++; }, query: { isPending: true } };
  const fixture = await mount(Field, props);
  try {
    assert.match(fixture.host.querySelector('[role="status"]').textContent, /Loading categories/);
    assert.ok(fixture.host.querySelector('[aria-label="Remove Saved category"]'));
    await fixture.render({ ...props, query: { data: [] } });
    assert.match(fixture.host.textContent, /No active categories/);
    assert.ok(fixture.host.querySelector('[aria-label="Remove Unavailable category"]'));
    assert.equal(mutations, 0);
  } finally { await fixture.cleanup(); }
});

test("all category labels render as wrapping accessible pills", async () => {
  const categories = [{ id: "a", name: "Clinical practice and professional development" }, { id: "b", name: "Research" }];
  const fixture = await mount(Badges, { categories });
  try {
    const lists = [...document.querySelectorAll('ul[aria-label="Session categories"]')];
    assert.equal(lists.length, 1);
    assert.equal(lists[0].children.length, 2);
    assert.ok(lists[0].classList.contains('flex-wrap'));
    assert.match(lists[0].textContent, /Clinical practice and professional development/);
    assert.match(lists[0].textContent, /Research/);
  } finally { await fixture.cleanup(); }
});
