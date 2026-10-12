import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const result = await build({
  entryPoints: ["client/src/components/sales/QuoteContactSelect.jsx"],
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  jsx: "automatic", alias: { "@": `${process.cwd()}/client/src` },
});
const mod = new Module(`${process.cwd()}/quote-contact-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, mod.filename || `${process.cwd()}/quote-contact-fixture.cjs`);
const savedId = "7136534a-ae47-4a4d-a983-f4ae9215ae13";

for (const label of ["Customer contact", "Billing contact"]) {
  test(`${label} never displays an ID during loading, errors or missing-contact recovery`, () => {
    let changes = 0;
    const render = props => renderToStaticMarkup(React.createElement(mod.exports.default, {
      label, value: savedId, contacts: [], emptyLabel: "Not selected",
      onChange: () => changes++, ...props,
    }));
    for (const [props, expected] of [
      [{ loading: true }, "Loading contacts"],
      [{ error: true }, "Unable to load contacts"],
      [{}, "Saved contact unavailable"],
      [{ contacts: [{ id: savedId, name: "Test Contact" }] }, "Test Contact"],
      [{ value: "" }, "Not selected"],
    ]) {
      const html = render(props);
      assert.match(html, new RegExp(expected));
      // UUIDs can remain as internal select values, never as visible field text.
      const visible = html.replace(/<[^>]*>/g, "");
      assert.ok(!visible.includes(savedId));
    }
    assert.equal(changes, 0);
  });
}
