import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "HTMLInputElement", "HTMLButtonElement", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");

const boardSource = readFileSync("client/src/pages/ProjectBoard.jsx", "utf8");
assert.match(boardSource, /ProjectBoardInbox boardId=\{boardId\} onOpenCard=\{openCardDetail\}/);
const bundle = await build({
  stdin: {
    contents: `export {default as Inbox} from "./client/src/components/projects/ProjectBoardInbox.jsx";
      export {default as Picker} from "./client/src/components/projects/BoardMentionTextarea.jsx";
      export {default as Modal} from "./client/src/components/sales/ProjectCardDetailModal.jsx";`,
    resolveDir: process.cwd(), loader: "jsx",
  },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  jsx: "automatic", loader: { ".css": "empty" }, alias: { "@": resolve("client/src") }, logLevel: "silent",
});
const bundled = new Module(`${process.cwd()}/board-mentions-isolated.cjs`);
bundled.filename = `${process.cwd()}/board-mentions-isolated.cjs`;
bundled.paths = Module._nodeModulePaths(process.cwd());
bundled._compile(bundle.outputFiles[0].text, bundled.filename);
const { Inbox, Picker, Modal } = bundled.exports;
const { QueryClient, QueryClientProvider } = bundled.require("@tanstack/react-query");
const h = React.createElement;
const originalFetch = globalThis.fetch;
const mounts = [];
const members = [
  { identity_id: "mia", first_name: "Mia", last_name: "Chen", email: "mia@example.test" },
  { identity_id: "jules", first_name: "Jules", last_name: "Le Roy", email: "jules@example.test" },
];
const item = { id: "mention-1", card_id: "card-1", comment_id: "comment-1", card_title: "Review checklist", content: "@Mia Chen please review.", author_name: "Jules Le Roy", created_at: "2026-03-12T09:23:00Z", read_at: null, pinned_at: null };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tick = () => act(async () => { await new Promise((done) => setTimeout(done, 15)); });
async function waitFor(predicate, label) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await tick(); }
  assert.fail(`Timed out: ${label}`);
}
async function mount(component, transport) {
  globalThis.fetch = transport || (() => { throw new Error("No transport fixture supplied"); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounts.push({ root, client, host });
  await act(async () => root.render(h(QueryClientProvider, { client }, component)));
  return { host, client };
}
async function click(node) { assert.ok(node, "Clickable element exists"); await act(async () => node.click()); }
async function type(node, value) {
  assert.ok(node, "Textarea exists");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(node, value);
    node.setSelectionRange(value.length, value.length);
    node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function key(node, value) {
  await act(async () => node.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
afterEach(async () => {
  for (const { root, client, host } of mounts.splice(0)) {
    await act(async () => root.unmount());
    client.clear(); host.remove();
  }
});
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });

test("keyboard and pointer mentions: explicit selection, deduplication, exact label removal, Escape", async () => {
  let picked;
  function Harness() {
    const [value, setValue] = React.useState("");
    const [mentions, setMentions] = React.useState([]);
    picked = mentions;
    return h(Picker, { value, onChange: setValue, mentions, onMentionsChange: setMentions, members, "aria-label": "Write" });
  }
  const { host } = await mount(h(Harness));
  const input = host.querySelector("textarea");
  await type(input, "@");
  assert.equal(host.querySelectorAll('[role="option"]').length, 2);
  await key(input, "ArrowDown");
  assert.equal(host.querySelector('[aria-selected="true"]').textContent.includes("Jules Le Roy"), true);
  await key(input, "Enter");
  assert.equal(input.value, "@Jules Le Roy ");
  assert.deepEqual(picked, [{ id: "jules", label: "Jules Le Roy" }]);
  await type(input, "@Jules Le Roy t");
  assert.equal(host.querySelector('[role="listbox"]'), null, "typing after a chosen mention keeps the picker closed");
  await click(input);
  assert.equal(host.querySelector('[role="listbox"]'), null, "clicking after a chosen mention keeps the picker closed");
  await type(input, "@Jules Le Roy thanks @Mi");
  assert.equal(host.querySelectorAll('[role="option"]').length, 1, "a fresh @ still opens the picker");
  await click(host.querySelector('[role="option"]'));
  await type(input, "@Jules Le Roy thanks @Mia Chen please review");
  assert.equal(host.querySelector('[role="listbox"]'), null, "pointer-selected mentions also stay closed");
  await type(input, "@Jules Le Roy @Ju");
  await click(host.querySelector('[role="option"]'));
  assert.equal(picked.length, 1);
  await type(input, "@Jules Le Ro");
  assert.deepEqual(picked, []);
  await key(input, "Escape");
  assert.equal(host.querySelector('[role="listbox"]'), null);
  await type(input, "Email mia@example.test");
  assert.equal(host.querySelector('[role="listbox"]'), null);
});

test("inbox explicit actions, scoped bulk read, checked card access and no implicit read", async () => {
  const writes = [], reads = [], opened = [];
  let current = { ...item };
  const { host, client } = await mount(h(Inbox, { boardId: "board-1", onOpenCard: (card) => opened.push(card) }), async (url, options = {}) => {
    reads.push({ url: String(url), options });
    if (String(url).startsWith("/api/projects/cards/")) return json({ card: { id: "card-1", board_id: "board-1", title: "Review checklist" } });
    assert.ok(String(url).startsWith("/api/projects/boards/board-1/inbox"));
    assert.equal(options.credentials, "include");
    if (options.method === "PATCH") {
      const body = JSON.parse(options.body); writes.push(body);
      if (typeof body.read === "boolean") current.read_at = body.read ? "2026-03-12" : null;
      if (typeof body.pinned === "boolean") current.pinned_at = body.pinned ? "2026-03-12" : null;
      return json({ updated: true });
    }
    return json({ items: [current], total: 1, unreadCount: current.read_at ? 0 : 1, page: 1, pageSize: 30 });
  });
  await waitFor(() => host.querySelector('[aria-label="Open card: Review checklist"]'), "inbox loaded");
  const query = client.getQueryCache().find({ queryKey: ["board-inbox", "board-1", 1] });
  assert.equal(query.options.refetchInterval, 30000);
  assert.equal(query.options.refetchIntervalInBackground, false);
  await click(host.querySelector('[aria-label="Open card: Review checklist"]'));
  await waitFor(() => opened.length === 1, "card opened");
  assert.equal(writes.length, 0);
  assert.ok(reads.some((request) => request.url === "/api/projects/cards/card-1"));
  await click(host.querySelector('[aria-label="Pin mention"]'));
  await waitFor(() => host.querySelector('[aria-label="Unpin mention"]:not(:disabled)'), "pin refetched");
  assert.deepEqual(writes.at(-1), { ids: ["mention-1"], pinned: true });
  await click(host.querySelector('[aria-label="Unpin mention"]'));
  await waitFor(() => host.querySelector('[aria-label="Pin mention"]:not(:disabled)'), "unpin refetched");
  assert.deepEqual(writes.at(-1), { ids: ["mention-1"], pinned: false });
  await click(host.querySelector('[aria-label="Mark read"]'));
  await waitFor(() => host.querySelector('[aria-label="Mark unread"]:not(:disabled)'), "read refetched");
  assert.deepEqual(writes.at(-1), { ids: ["mention-1"], read: true });
  await click(host.querySelector('[aria-label="Mark unread"]'));
  await waitFor(() => host.querySelector('[aria-label="Mark read"]:not(:disabled)'), "unread refetched");
  await click(host.querySelector('[aria-label="Select all mentions on this page"]'));
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "Mark read"));
  await waitFor(() => host.querySelector('[aria-label="Mark unread"]:not(:disabled)'), "bulk selected read");
  assert.deepEqual(writes.at(-1), { ids: ["mention-1"], read: true });
  await click(host.querySelector('[aria-label="Mark unread"]'));
  await waitFor(() => host.querySelector('[aria-label="Mark read"]:not(:disabled)'), "unread for all read");
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "Mark all read"));
  await waitFor(() => writes.at(-1)?.all, "mark all");
  assert.deepEqual(writes.at(-1), { all: true, read: true });
});

test("deleted card and forbidden card give clear errors with retry; inbox read status is untouched", async () => {
  let status = 404, calls = 0;
  const { host } = await mount(h(Inbox, { boardId: "board-1", onOpenCard: () => assert.fail("Unavailable card opened") }), async (url, options = {}) => {
    assert.notEqual(options.method, "PATCH");
    if (String(url).includes("/cards/")) { calls++; return json({ error: "Unavailable" }, status); }
    return json({ items: [item], total: 1, unreadCount: 1, page: 1, pageSize: 30 });
  });
  await waitFor(() => host.querySelector('[aria-label="Open card: Review checklist"]'), "inbox loaded");
  await click(host.querySelector('[aria-label="Open card: Review checklist"]'));
  await waitFor(() => host.textContent.includes("deleted or archived"), "deleted card error");
  status = 403;
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "Try again"));
  await waitFor(() => host.textContent.includes("no longer have access"), "permission error");
  assert.equal(calls, 2);
});

test("inbox loading, network error/retry and empty states", async () => {
  let fail = true, release;
  const first = new Promise((resolveResponse) => { release = resolveResponse; });
  let calls = 0;
  const { host } = await mount(h(Inbox, { boardId: "board-1", onOpenCard: () => {} }), async () => {
    if (++calls === 1) return first;
    return fail ? json({ error: "Fixture unavailable" }, 503) : json({ items: [], total: 0, unreadCount: 0, page: 1, pageSize: 30 });
  });
  assert.ok(host.querySelector('[aria-label="Loading your mentions"]'));
  await act(async () => release(json({ error: "Fixture unavailable" }, 503)));
  await waitFor(() => host.textContent.includes("couldn’t load"), "load error");
  fail = false;
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "Retry"));
  await waitFor(() => host.textContent.includes("Nothing waiting for you"), "empty after retry");
});

test("inbox pagination clears page selection and uses the contract pageSize", async () => {
  const calls = [];
  const { host } = await mount(h(Inbox, { boardId: "board-1", onOpenCard: () => {} }), async (url) => {
    calls.push(String(url));
    const page = Number(new URL(String(url), "https://fixture.test").searchParams.get("page"));
    return json({ items: [{ ...item, id: `notice-${page}`, card_title: `Card page ${page}` }], total: 31, unreadCount: 31, page, pageSize: 30 });
  });
  await waitFor(() => host.querySelector('[aria-label="Open card: Card page 1"]'), "first page");
  await click(host.querySelector('[aria-label="Select all mentions on this page"]'));
  assert.ok(host.textContent.includes("1 selected"));
  await click(host.querySelector('[aria-label="Next inbox page"]'));
  await waitFor(() => host.querySelector('[aria-label="Open card: Card page 2"]'), "second page");
  assert.equal(host.textContent.includes("1 selected"), false);
  assert.ok(calls.some((url) => url.endsWith("?page=2&pageSize=30")));
});

test("shared comment modal sends picked IDs only, invalidates board inbox, preserves ordinary comments and viewer permissions", async () => {
  const writes = [], invalidated = [];
  const props = { card: { id: "card-1", board_id: "board-1", list_id: "list-1", title: "Review checklist" }, open: true, onOpenChange: () => {}, boardId: "board-1", members, lists: [{ id: "list-1", name: "Review" }], canEdit: true, canManage: false, onUpdate: () => {}, onDelete: () => {} };
  const transport = async (url, options = {}) => {
    if (String(url) === "/api/projects/boards/board-1/inbox" && options.method === "PATCH") {
      assert.deepEqual(JSON.parse(options.body), { cardId: "card-1", read: true });
      return json({ success: true });
    }
    if (String(url).endsWith("/comments") && options.method === "POST") {
      const body = JSON.parse(options.body); writes.push(body);
      return json({ comment: { id: `new-${writes.length}`, content: body.content, identity_id: "mia", created_at: "2026-03-12T10:23:00Z" } });
    }
    if (String(url) === "/api/projects/cards/card-1") return json({ card: props.card, comments: [], activity: [], attachments: [] });
    throw new Error(`Blocked unknown fixture request ${url}`);
  };
  const { client } = await mount(h(Modal, props), transport);
  client.setQueryDefaults(["project-board", "board-1"], { gcTime: Infinity });
  client.setQueryData(["project-board", "board-1"], { cards: [
    { ...props.card, project_card_comment: [{ count: 0 }] },
    { id: "untouched", title: "Other task" },
  ] });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (options) => { invalidated.push(options); return invalidate(options); };
  await waitFor(() => document.querySelector('[data-testid="input-new-comment"]'), "comment input");
  const input = document.querySelector('[data-testid="input-new-comment"]');
  await type(input, "Thanks @Mia");
  await key(input, "Enter");
  await click(document.querySelector('[data-testid="button-add-comment"]'));
  await waitFor(() => writes.length === 1 && !document.querySelector('[data-testid="button-add-comment"]').textContent.includes("Posting"), "picked comment posted");
  assert.deepEqual(writes[0], { content: "Thanks @Mia Chen ", mentionIdentityIds: ["mia"] });
  assert.equal(client.getQueryData(["project-board", "board-1"]).cards[0].project_card_comment[0].count, 1);
  assert.deepEqual(client.getQueryData(["project-board", "board-1"]).cards[1], { id: "untouched", title: "Other task" });
  assert.ok(invalidated.some((options) => JSON.stringify(options.queryKey) === JSON.stringify(["board-inbox", "board-1"])));
  assert.ok(invalidated.some((options) => options.exact && JSON.stringify(options.queryKey) === JSON.stringify(["inbox"])));
  assert.ok(invalidated.some((options) => JSON.stringify(options.queryKey) === JSON.stringify(["inbox", "unread"])));
  await type(input, "Plain @Mia Chen typed, not picked.");
  await click(document.querySelector('[data-testid="button-add-comment"]'));
  await waitFor(() => writes.length === 2 && input.value === "", "ordinary comment posted");
  assert.deepEqual(writes[1].mentionIdentityIds, []);
  assert.equal(client.getQueryData(["project-board", "board-1"]).cards[0].project_card_comment[0].count, 2);
  const root = mounts.at(-1).root;
  await act(async () => root.render(h(QueryClientProvider, { client }, h(Modal, { ...props, canEdit: false }))));
  assert.equal(document.querySelector('[data-testid="input-new-comment"]'), null);
});
