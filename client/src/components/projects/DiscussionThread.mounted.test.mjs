import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const bundlePath = path.resolve(`client/src/components/projects/.discussion-thread-fixture-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export { default } from "@/components/projects/DiscussionThread";`,
    resolveDir: path.resolve("client/src"), loader: "jsx",
  },
  outfile: bundlePath, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "transform",
  alias: { "@": path.resolve("client/src") }, define: { "import.meta.env": "{}" }, logLevel: "silent",
  plugins: [{
    name: "discussion-ui-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /^@\/components\/ui\/(button|avatar)$/ }, ({ path: entry }) => ({ path: entry, namespace: "ui-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "ui-fixture" }, ({ path: entry }) => ({
        loader: "jsx",
        contents: entry.endsWith("button")
          ? `export const Button = ({children, ...props}) => <button type="button" {...props}>{children}</button>;`
          : `export const Avatar = ({children, ...props}) => <span {...props}>{children}</span>;
             export const AvatarFallback = ({children, ...props}) => <span {...props}>{children}</span>;
             export const AvatarImage = () => null;`,
      }));
      builder.onResolve({ filter: /^\.\/ActivityComposer$/ }, () => ({ path: "composer", namespace: "composer-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "composer-fixture" }, () => ({ loader: "jsx", contents: "export default () => null;" }));
      builder.onResolve({ filter: /\.css$/ }, ({ path: entry }) => ({ path: entry, namespace: "css-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "css-fixture" }, () => ({ loader: "js", contents: "export default {};" }));
    },
  }],
});
const { default: DiscussionThread } = await import(pathToFileURL(bundlePath).href);
after(async () => {
  dom.window.close();
  await unlink(bundlePath);
  await unlink(bundlePath.replace(/\.mjs$/, ".css")).catch((error) => { if (error.code !== "ENOENT") throw error; });
});

const rootComment = {
  id: "root", parent_comment_id: null, identity_id: "member-a", can_edit: true,
  author: { first_name: "Maya", last_name: "Stone" }, content: "literal <b>markup</b>",
  created_at: "2026-11-24T10:00:00Z", reactions: [{ emoji: "👍", count: 1, selected: true, reactors: [{ id: "member-b", name: "Owen Park" }] }],
};
const replyComment = {
  id: "reply", parent_comment_id: "root", reply_to_comment_id: "root", reply_to_name: "Maya Stone",
  identity_id: "member-b", can_edit: false, author: { first_name: "Owen", last_name: "Park" },
  rich_content: { version: 1, doc: { type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "Confirmed", marks: [{ type: "bold" }] },
  ] }] } }, content: "Confirmed", created_at: "2026-11-24T10:01:00Z", reactions: [],
};

async function mount(canWrite) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container);
  const node = createRoot(container);
  await act(async () => node.render(React.createElement(QueryClientProvider, { client },
    React.createElement(DiscussionThread, {
      comments: [rootComment, replyComment], cardId: "card-a", boardId: "board-a", members: [], canWrite,
      drafts: new Map(), refresh: async () => {},
    }))));
  return { container, close: async () => { await act(async () => node.unmount()); client.clear(); container.remove(); } };
}

test("thread renderer preserves legacy markup as text, renders rich marks and gates author controls", async () => {
  const viewer = await mount(false);
  try {
    assert.equal(viewer.container.querySelector('[data-comment-id="root"] b'), null);
    assert.match(viewer.container.textContent, /literal <b>markup<\/b>/);
    assert.equal(viewer.container.querySelector('[data-comment-id="reply"] strong')?.textContent, "Confirmed");
    assert.equal([...viewer.container.querySelectorAll("button")].some((button) => button.textContent.includes("Reply")), false);
    assert.equal(viewer.container.querySelector('[aria-label="Edit comment"]'), null);
    assert.equal(viewer.container.querySelector('[aria-label="Add reaction"]'), null);
  } finally { await viewer.close(); }

  const member = await mount(true);
  try {
    assert.ok(member.container.querySelector('[aria-label="Edit comment"]'));
    assert.ok(member.container.querySelector('[aria-label="Delete comment"]'));
    assert.ok(member.container.querySelector('[aria-label="Add reaction"]'));
    assert.ok(member.container.querySelector('[aria-label="👍, 1 reaction; show reactors: Owen Park"]'));
    assert.match(member.container.textContent, /Replying to Maya Stone/);
  } finally { await member.close(); }
});
