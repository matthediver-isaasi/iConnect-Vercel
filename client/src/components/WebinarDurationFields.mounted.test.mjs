import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { isValidWebinarDuration, WEBINAR_DURATION_ERROR } from "../../../shared/zoomWebinarDuration.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Node", "Event"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const result = await build({
  entryPoints: ["client/src/components/WebinarDurationFields.jsx"],
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  packages: "external",
  alias: { "@": path.resolve("client/src"), "@shared": path.resolve("shared") },
});
const compiled = new Module(path.resolve("client/src/components/duration-test.cjs"));
compiled.filename = path.resolve("client/src/components/duration-test.cjs");
compiled.paths = Module.createRequire(import.meta.url).resolve.paths("react");
compiled._compile(result.outputFiles[0].text, compiled.filename);
const WebinarDurationFields = compiled.exports.default;
after(() => dom.window.close());

async function mount(initialMinutes = 60, id = "duration") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let value = initialMinutes;
  const render = async (minutes = value, key = "initial", open = true) => {
    await act(async () => root.render(open ? React.createElement(WebinarDurationFields, {
      key, id, durationMinutes: minutes,
      onChange(next) { value = next; },
    }) : null));
  };
  await render();
  const input = part => host.querySelector(`#${id}-${part}`);
  return {
    host, input, render, value: () => value,
    async change(part, text) {
      await act(async () => {
        const element = input(part);
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(element, text);
        element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      // Match the parent's controlled duration update without replacing raw drafts.
      await render();
    },
    async cleanup() { await act(async () => root.unmount()); host.remove(); },
  };
}

for (const id of ["duration", "edit-duration"]) {
  test(`${id}: defaults to 1h 0m and converts a full study day to 450 minutes`, async () => {
    const fixture = await mount(60, id);
    try {
      assert.equal(fixture.input("hours").value, "1");
      assert.equal(fixture.input("minutes").value, "0");
      await fixture.change("hours", "7");
      await fixture.change("minutes", "30");
      assert.equal(fixture.value(), 450);
      assert.equal(fixture.host.querySelector('[role="alert"]'), null);
    } finally { await fixture.cleanup(); }
  });

  for (const [hours, minutes] of [["", "0"], ["1", ""], ["0", "0"], ["-1", "30"], ["1.5", "0"], ["0", "-1"], ["0", "1.5"], ["0", "60"]]) {
    test(`${id}: invalid parts ${JSON.stringify([hours, minutes])} stay editable and produce null`, async () => {
      const fixture = await mount(60, id);
      try {
        await fixture.change("hours", hours);
        await fixture.change("minutes", minutes);
        assert.equal(fixture.value(), null);
        assert.equal(fixture.input("hours").value, hours);
        assert.equal(fixture.input("minutes").value, minutes);
        assert.equal(fixture.input("hours").getAttribute("aria-invalid"), "true");
        assert.equal(fixture.host.querySelector('[role="alert"]').textContent, WEBINAR_DURATION_ERROR);
        await fixture.change("hours", "0");
        await fixture.change("minutes", "1");
        assert.equal(fixture.value(), 1);
        assert.equal(fixture.host.querySelector('[role="alert"]'), null);
      } finally { await fixture.cleanup(); }
    });
  }

  test(`${id}: prefills existing 450 minutes, resets on reopen and another webinar`, async () => {
    const fixture = await mount(450, id);
    try {
      assert.equal(fixture.input("hours").value, "7");
      assert.equal(fixture.input("minutes").value, "30");
      await fixture.change("hours", "");
      await fixture.render(null, "initial", false);
      await fixture.render(450);
      assert.equal(fixture.input("hours").value, "7");
      assert.equal(fixture.input("minutes").value, "30");
      await fixture.render(545, "another-webinar");
      assert.equal(fixture.input("hours").value, "9");
      assert.equal(fixture.input("minutes").value, "5");
    } finally { await fixture.cleanup(); }
  });
}

test("both actual submit handlers reject invalid durations before performing any work", () => {
  const source = readFileSync("client/src/pages/ZoomWebinarProvisioning.jsx", "utf8");
  for (const name of ["handleSubmit", "handleEditSubmit"]) {
    const start = source.indexOf(`  const ${name} = () => {`);
    const body = source.slice(start + `  const ${name} = () => {`.length, source.indexOf("\n  };", start));
    const handler = new Function("formData", "toast", "isValidWebinarDuration", "WEBINAR_DURATION_ERROR", body);
    for (const duration_minutes of [null, undefined, "", 0, -1, 1.5, NaN]) {
      const errors = [];
      handler({ duration_minutes }, { error: message => errors.push(message) }, isValidWebinarDuration, WEBINAR_DURATION_ERROR);
      assert.deepEqual(errors, [WEBINAR_DURATION_ERROR]);
    }
  }
});
