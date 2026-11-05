import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  stdin: {
    contents: `import React from 'react';
import { useCookieConsent } from '@/hooks/useCookieConsent';
import { consentState } from '@/lib/consentState';
import { popupDurableStorageAllowed } from '@/lib/popupRuntimeState';
export const publish = next => consentState.publish(next);
export default function Harness() {
 const consent = useCookieConsent();
 return <output data-consented={String(consent.hasConsented)} data-durable={String(popupDurableStorageAllowed(consent))}/>;
}`,
    resolveDir: process.cwd(), loader: "jsx",
  },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
});
const module = new Module(`${process.cwd()}/popup-consent-isolated.cjs`);
module.filename = `${process.cwd()}/popup-consent-isolated.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(bundle.outputFiles[0].text, module.filename);
after(() => dom.window.close());
test("popup persistence follows the real useCookieConsent analytics policy, including revocation", async () => {
  const root = createRoot(document.getElementById("root"));
  const update = async (ready, hasActed, analytics, functional = true) => {
    await React.act(async () => module.exports.publish({ ready, hasActed, categories: { necessary: true, functional, analytics, marketing: false } }));
    return document.querySelector("output").dataset;
  };
  await React.act(async () => root.render(React.createElement(module.exports.default)));
  try {
    assert.equal((await update(false, false, false)).durable, "false");
    const functionalOnly = await update(true, true, false);
    assert.equal(functionalOnly.consented, "false");
    assert.equal(functionalOnly.durable, "false");
    assert.equal((await update(true, false, true)).durable, "false", "unacted consent is never permission");
    const accepted = await update(true, true, true);
    assert.equal(accepted.consented, "true");
    assert.equal(accepted.durable, "true");
    assert.equal((await update(true, true, false)).durable, "false", "revocation immediately disables persistence");
  } finally { await React.act(async () => root.unmount()); }
});
