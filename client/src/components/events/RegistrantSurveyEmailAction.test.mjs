import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import Module from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { JSDOM } from "jsdom";
const require = Module.createRequire(import.meta.url);
const dom = new JSDOM("<html><body></body></html>", { url: "https://test.example" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
after(() => dom.window.close());
const bundle = await build({
  entryPoints: ["client/src/components/events/RegistrantSurveyEmailAction.jsx"],
  bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic", external: ["react"],
  plugins: [{
    name: "ui-fixtures",
    setup(b) {
      b.onResolve({ filter: /^@\/components\/ui\/|^lucide-react$|^sonner$|^@tanstack\/react-query$/ }, args => ({ path: args.path, namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        loader: "js",
        contents: args.path === "@tanstack/react-query" ? "export const useQuery=()=>globalThis.__surveyChoices;"
          : args.path === "sonner" ? "export const toast={success(){}};"
          : args.path === "lucide-react" ? "export const Mail=()=>null; export const Loader2=()=>null;"
          : `import React from "react";
            export const Button=({children,variant,size,...p})=>React.createElement('button',p,children);
            export const Dialog=({children,open})=>open?React.createElement('div',{},children):null;
            export const DialogContent=({children,...p})=>React.createElement('div',p,children);
            export const DialogHeader=({children})=>React.createElement('div',{},children);
            export const DialogTitle=({children})=>React.createElement('h2',{},children);
            export const DialogDescription=({children})=>React.createElement('p',{},children);
            export const Tooltip=({children})=>React.createElement('div',{},children);
            export const TooltipTrigger=({children})=>children;
            export const TooltipContent=()=>null;`,
      }));
    },
  }],
});
const mod = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, mod, mod.exports);
const Action = mod.exports.default;
const identity = { event_id: "event", booking_id: "booking", booking_source: "standard" };
async function mount(choices, attendee = {}) {
  globalThis.__surveyChoices = choices;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Action, { identity, attendee: { status: "confirmed", ...attendee } })));
  return { host, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const button = (host, text) => [...host.querySelectorAll("button")].find(b => b.textContent === text);

test("suppresses non-attendees, disables absent surveys, and permits verified attendees", async () => {
  let view = await mount({ data: { tracking: true, surveys: [{ id: "survey", name: "Feedback" }] } });
  assert.equal(view.host.querySelector("button"), null); await view.close();
  view = await mount({ data: { tracking: false, surveys: [] } });
  assert.equal(view.host.querySelector("button").disabled, true); await view.close();
  view = await mount({ data: { tracking: true, surveys: [{ id: "survey" }] } }, { attendance_status: "attended" });
  assert.equal(view.host.querySelector("button").disabled, false); await view.close();
});

test("untracked send requires email preview and acknowledgement and sends only selected survey", async () => {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const input = JSON.parse(options.body); calls.push(input);
    return { ok: true, json: async () => input.action === "preview"
      ? { recipient: "guest@example.org", subject: "Feedback", html: "<p>Invitation</p>", fingerprint: "fresh", attendance_warning: true }
      : { sent: true } };
  };
  const view = await mount({ data: { tracking: false, surveys: [{ id: "one", name: "First" }, { id: "two", name: "Second" }] } });
  try {
    await act(async () => view.host.querySelector("button").click());
    assert.match(view.host.textContent, /No attendance verification/);
    assert.equal(button(view.host, "Preview email").disabled, true);
    const select = view.host.querySelector("select");
    await act(async () => Simulate.change(select, { target: { value: "two" } }));
    await act(async () => button(view.host, "Preview email").click());
    assert.equal(calls.length, 1); assert.equal(calls[0].action, "preview");
    assert.match(view.host.textContent, /guest@example.org/);
    assert.equal(view.host.querySelector("iframe").getAttribute("sandbox"), "");
    assert.equal(button(view.host, "Confirm and send").disabled, true);
    await act(async () => Simulate.change(view.host.querySelector('input[type="checkbox"]'), { target: { checked: true } }));
    await act(async () => button(view.host, "Confirm and send").click());
    assert.equal(calls.length, 2);
    assert.equal(calls[1].action, "send");
    assert.equal(calls[1].assignment_id, "two");
    assert.equal(calls[1].acknowledge_unverified, true);
    assert.equal(calls[1].expected_fingerprint, "fresh");
    assert.equal(calls[1].booking_id, identity.booking_id);
  } finally { await view.close(); }
});
