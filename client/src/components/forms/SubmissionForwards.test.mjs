import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  stdin: {
    contents: `export {default} from "./client/src/components/forms/SubmissionForwards.jsx";
      export {state} from "@/hooks/useSubmissionForwards";`,
    resolveDir: process.cwd(), loader: "jsx",
  },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "forward-test-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\/components\/ui\// }, args => ({ path: args.path, namespace: "ui" }));
      builder.onLoad({ filter: /.*/, namespace: "ui" }, () => ({
        loader: "jsx", contents: `import React from "react";
          const Box = ({children}) => <div>{children}</div>;
          const Button = ({children, ...props}) => <button {...props}>{children}</button>;
          export {Button}; export const Input = props => <input {...props}/>;
          export const Label = ({children,...props}) => <label {...props}>{children}</label>;
          export const Badge = Box;
          export const Dialog = ({open,children}) => open ? <div role="dialog">{children}</div> : null;
          export const AlertDialog = Dialog;
          export const DialogContent = Box, DialogDescription = Box, DialogFooter = Box, DialogHeader = Box, DialogTitle = Box;
          export const AlertDialogContent = Box, AlertDialogDescription = Box, AlertDialogFooter = Box, AlertDialogHeader = Box, AlertDialogTitle = Box;
          export const AlertDialogAction = Button, AlertDialogCancel = Button;`,
      }));
      builder.onResolve({ filter: /^@\/components\/SimpleRichTextEditor$/ }, () => ({ path: "editor", namespace: "mock" }));
      builder.onResolve({ filter: /^@\/hooks\/useSubmissionForwards$/ }, () => ({ path: "hooks", namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({
        loader: "jsx",
        contents: args.path === "editor" ? `import React from "react";
          export default function Editor({content,onChange,disabled,...props}) {
            return <textarea {...props} disabled={disabled} value={content} onChange={event=>onChange(event.target.value)}/>;
          }` : `
          export const state = {calls: [], detailEnabled: [], result: null, fail: false, pending:false, denied:false, historyError:false, history: {forwards: [],can_forward:true}};
          export const useSubmissionForwardHistory = (scope,id,enabled) => {
            state.detailEnabled.push(enabled);
            return {data:state.pending ? undefined : {...state.history,can_forward:!state.denied},
              refetch:async()=>{},isFetching:state.pending,isPending:state.pending,isError:state.historyError,error:new Error("Access check unavailable")};
          };
          export const useSubmissionForwardMembers = () => ({data:{members:[{id:"member-a",first_name:"Priya",last_name:"Shah",email:"priya@example.test"}]}});
          export async function submissionForwardRequest(scope,params,payload) {
            scope.assertCurrent(); state.calls.push({scope:scope.scopeKey,payload});
            if(state.fail) throw new Error("Connection lost");
            return state.result || {forward:{id:"forward-a",status:"sent",recipient_name:"Priya Shah",recipient_email:"priya@example.test"}};
          }`,
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/submission-forward-test.cjs`);
mod.filename = `${process.cwd()}/submission-forward-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const Component = mod.exports.default;
const state = mod.exports.state;
const listHistory = submissionId => ({
  data: { [submissionId]: state.history.forwards },
  refetch: async () => {}, isPending: false, isError: false,
});
after(() => dom.window.close());

test("per-submission history, confidentiality notice, disabled-send guidance and cancel", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const scope = { scopeKey: "tenant-a", status: "ready", assertCurrent() {} };
  const button = label => [...container.querySelectorAll("button")].find(node => node.textContent === label);
  try {
    await act(async () => root.render(React.createElement(Component, { scope, submissionId: "submission-test", listHistory: listHistory("submission-test") })));
    assert.equal(state.detailEnabled.at(-1), false, "list rows must not request single-submission history");
    assert.match(container.textContent, /Forwarding history/);
    assert.match(container.textContent, /No forwards yet/);
    await act(async () => button("Forward submission").click());
    assert.equal(state.detailEnabled.at(-1), true, "open dialog checks single-submission authorization");
    assert.match(container.textContent, /anyone with this link can view/);
    assert.match(container.textContent, /7 days/);
    assert.equal(button("Send email").disabled, true);
    assert.match(container.textContent, /Choose a tenant member with an email address/);
    assert.equal(container.querySelector('[aria-label="Forward email message"]').disabled, false);
    await act(async () => button("Cancel").click());
    assert.equal(container.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("recipient/date history stays visible and links can be revoked", async () => {
  state.history = { can_forward: true, forwards: [{
    id: "existing-forward", recipient_name: "Priya Shah", recipient_email: "priya@example.test",
    status: "sent", created_at: "2026-06-01T12:30:00Z", sent_at: "2026-06-01T12:30:00Z",
    expires_at: "2099-06-08T12:30:00Z",
  }] };
  state.calls.length = 0;
  const container = document.createElement("div");
  const root = createRoot(container);
  const scope = { scopeKey: "tenant-history", status: "ready", assertCurrent() {} };
  const button = label => [...container.querySelectorAll("button")].find(node => node.textContent === label);
  try {
    await act(async () => root.render(React.createElement(Component, { scope, submissionId: "submission-history", listHistory: listHistory("submission-history") })));
    assert.match(container.textContent, /Priya Shah/);
    assert.match(container.textContent, /priya@example.test/);
    assert.match(container.textContent, /2026/);
    assert.match(container.textContent, /Link expires/);
    assert.equal(button("Revoke link"), undefined, "row history does not assume bulk response grants forwarding permission");
    await act(async () => button("Forward submission").click());
    await act(async () => button("Revoke link").click());
    assert.match(container.textContent, /email cannot be recalled/);
    await act(async () => [...container.querySelectorAll("button")].filter(node => node.textContent === "Revoke link").at(-1).click());
    assert.deepEqual(state.calls[0], { scope: "tenant-history", payload: {
      action: "revoke", submission_id: "submission-history", forward_id: "existing-forward",
    } });
  } finally {
    await act(async () => root.unmount());
  }
});

test("dialog authorization loading, denied and failed checks keep send disabled with clear guidance", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const scope = { scopeKey: "tenant-permissions", status: "ready", assertCurrent() {} };
  const button = label => [...container.querySelectorAll("button")].find(node => node.textContent === label);
  const draw = async () => act(async () => root.render(React.createElement(Component, {
    scope, submissionId: "permission-test", listHistory: listHistory("permission-test"),
  })));
  try {
    state.pending = true;
    await draw();
    await act(async () => button("Forward submission").click());
    assert.match(container.textContent, /Checking forwarding access/);
    assert.equal(button("Send email").disabled, true);
    state.pending = false;
    state.denied = true;
    await draw();
    assert.match(container.textContent, /Forwarding is not available/);
    assert.equal(button("Send email").disabled, true);
    state.denied = false;
    state.historyError = true;
    await draw();
    assert.match(container.textContent, /Access check unavailable/);
    assert.match(container.textContent, /Load forwarding history before sending/);
    assert.ok(button("Retry history"));
    assert.equal(button("Send email").disabled, true);
  } finally {
    state.pending = state.denied = state.historyError = false;
    await act(async () => root.unmount());
  }
});
