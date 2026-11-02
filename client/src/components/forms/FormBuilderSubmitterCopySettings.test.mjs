import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent",
  "CustomEvent", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
}
globalThis.window = dom.window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Isolate the UI contract from shared helper/backend development.
const bundle = await build({
  entryPoints: ["client/src/components/forms/FormBuilderSubmitterCopySettings.jsx"],
  bundle: true,
  write: false,
  packages: "external",
  platform: "node",
  format: "cjs",
  plugins: [{
    name: "shared-copy-message-fixture",
    setup(builder) {
      builder.onResolve({ filter: /shared\/submitterCopyEmail\.js$/ }, () => ({
        path: "copy-message", namespace: "fixture",
      }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export const defaultSubmitterCopyMessage = (form, tenant) => `Your submission to ${form} for ${tenant} is attached.`;",
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/submitter-copy-ui-test.cjs`);
mod.filename = `${process.cwd()}/submitter-copy-ui-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const Settings = mod.exports.default;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
after(() => dom.window.close());

test("copy message edits, default reset, and toggle preserve controlled form state", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let current = { allow_submitter_email_copy: true, submitter_copy_email_message: null, name: "Application" };
  function Harness() {
    const [formData, setFormData] = React.useState(current);
    current = formData;
    return React.createElement(Settings, { formData, setFormData });
  }
  const textarea = () => container.querySelector("textarea");
  const toggle = () => container.querySelector('[role="switch"]');
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.match(textarea().value, /\{\{form_name\}\}/);
    assert.match(textarea().value, /\{\{tenant_name\}\}/);
    assert.equal(current.submitter_copy_email_message, null, "render must not persist the default");

    // React's controlled change callback, invoked as an input event by TestUtils.
    const { Simulate } = await import("react-dom/test-utils");
    await act(async () => Simulate.change(textarea(), { target: { value: "Thank you.\nYour copy is attached." } }));
    assert.equal(current.submitter_copy_email_message, "Thank you.\nYour copy is attached.");
    await act(async () => toggle().click());
    assert.equal(textarea(), null);
    assert.equal(current.submitter_copy_email_message, "Thank you.\nYour copy is attached.");
    await act(async () => toggle().click());
    assert.equal(textarea().value, "Thank you.\nYour copy is attached.");

    await act(async () => Simulate.change(textarea(), { target: { value: "" } }));
    assert.equal(textarea().value, "", "an explicit empty override must not be replaced during editing");
    await act(async () => container.querySelector('[data-testid="button-restore-submitter-copy-message"]').click());
    assert.equal(current.submitter_copy_email_message, null);
    assert.match(textarea().value, /\{\{form_name\}\}/);
    assert.equal(current.name, "Application", "updates retain unrelated form fields");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
