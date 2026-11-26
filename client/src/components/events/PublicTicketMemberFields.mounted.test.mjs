import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync } from "node:fs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Exercise the real switches and dialog primitives without APIs or credentials.
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
  entryPoints: ["client/src/components/events/PublicTicketMemberFields.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-ticket-settings",
    setup(builder) {
      builder.onResolve({ filter: /^(SelectedMemberAudience|TicketOrganizationTypeFields)$|^\.\/(SelectedMemberAudience|TicketOrganizationTypeFields)$/ },
        args => ({ path: args.path, namespace: "empty" }));
      builder.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default () => null;" }));
      builder.onResolve({ filter: /^@\// }, args => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/ticket-settings-fixture.cjs`);
compiled.filename = `${process.cwd()}/ticket-settings-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const click = element => act(async () => { assert.ok(element); element.click(); });

test("info dialogs explain the differences without changing or submitting settings", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes = [];
  let submitted = false;
  const ticket = { id: "fixture", visibility_mode: "public_only" };
  const render = next => act(async () => root.render(React.createElement("form", {
    onSubmit: event => { event.preventDefault(); submitted = true; },
  }, React.createElement(Component, { ticket: next, onChange: change => changes.push(change) }))));
  const about = label => host.querySelector(`button[aria-label="${label}"]`);
  try {
    await render(ticket);
    assert.equal(host.querySelectorAll('[role="switch"]').length, 2);
    for (const [label, heading, evidence] of [
      ["About automatically creating guest accounts", "Guest accounts and contact records", /before payment/],
      ["About creating member contact records", "Contact records only", /do not provide sign-in/],
    ]) {
      const trigger = about(label);
      assert.equal(trigger.type, "button");
      trigger.focus();
      await click(trigger);
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.equal(dialog.querySelector("h2").textContent, heading);
      assert.match(dialog.textContent, evidence);
      assert.match(dialog.textContent, /marketing consent/);
      assert.match(dialog.textContent, /association settings/);
      assert.match(dialog.textContent, /Invoice \/ PO/);
      await click([...dialog.querySelectorAll("button")].find(button => button.textContent === "Close"));
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(document.activeElement, trigger);
    }
    assert.deepEqual(changes, []);
    assert.equal(submitted, false);
    await click(host.querySelector("#guest-accounts-fixture"));
    assert.deepEqual(changes.pop(), { auto_create_guest_accounts: true, create_member_records: true, new_member_role_id: null });
    await render({ ...ticket, auto_create_guest_accounts: true, create_member_records: true });
    assert.equal(host.querySelectorAll('[role="switch"]').length, 1);
    assert.equal(about("About creating member contact records"), null);
    await click(host.querySelector("#guest-accounts-fixture"));
    assert.deepEqual(changes.pop(), { auto_create_guest_accounts: false, create_member_records: false, new_member_role_id: null });
    await render(ticket);
    await click(host.querySelector("#create-members-fixture"));
    assert.deepEqual(changes.pop(), { create_member_records: true, new_member_role_id: null });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
