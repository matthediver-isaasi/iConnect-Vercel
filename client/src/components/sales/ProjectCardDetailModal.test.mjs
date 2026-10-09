import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Local fixtures only: unexpected network calls fail the test.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent,
  NodeFilter: dom.window.NodeFilter, KeyboardEvent: dom.window.KeyboardEvent,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider, useQuery } = await import("@tanstack/react-query");
const bundlePath = path.resolve(`client/src/components/sales/.card-modal-fixture-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export { default } from "@/components/sales/ProjectCardDetailModal";
      export { default as Summary } from "@/components/projects/ProjectCardTileSummary";`,
    resolveDir: path.resolve("client/src"), loader: "jsx",
  },
  outfile: bundlePath,
  bundle: true, format: "esm", platform: "node", packages: "external", jsx: "transform",
  alias: { "@": path.resolve("client/src") }, define: { "import.meta.env": "{}" }, logLevel: "silent",
  plugins: [{
    name: "modal-boundary-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /^sonner$/ }, () => ({ path: "sonner", namespace: "toast-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "toast-fixture" }, () => ({
        contents: "export const toast = { error: (...args) => globalThis.cardMentionErrors?.push(args), success: () => {} };",
      }));
      builder.onResolve({ filter: /^@\/components\/(ui\/dialog|ui\/select|projects\/CardAttachments)$/ },
        ({ path: entry }) => ({ path: entry, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: entry }) => {
        if (entry.endsWith("CardAttachments")) return { loader: "jsx", contents: `
          export const CardCoverSection = ({ coverImage, onCoverChange, presentation, canEdit }) => <button data-testid="fixture-cover" data-presentation={presentation} data-cover={coverImage || ""} disabled={!canEdit} onClick={() => onCoverChange("new-cover").catch(error => { globalThis.coverError = error.message; })}>Change cover</button>;
          export const CardAttachments = ({ coverImage }) => <div data-testid="fixture-attachments" data-cover={coverImage || ""} />;
        ` };
        if (entry.endsWith("dialog")) return { loader: "jsx", contents: `
          export const Dialog = ({ open, children }) => open ? <div>{children}</div> : null;
          export const DialogContent = ({ children, ...props }) => <div {...props}>{children}</div>;
          export const DialogHeader = ({ children, ...props }) => <header {...props}>{children}</header>;
          export const DialogTitle = ({ children, ...props }) => <h1 {...props}>{children}</h1>;
          export const DialogDescription = ({ children, ...props }) => <p {...props}>{children}</p>;
          export const DialogFooter = ({ children, ...props }) => <footer {...props}>{children}</footer>;
        ` };
        return { loader: "jsx", contents: `
          export const Select = ({ value, disabled, onValueChange, children }) => <div><select aria-label="fixture-select" value={value} disabled={disabled} onChange={e => onValueChange(e.target.value)}><option value="list-a">Planning</option><option value="none">none</option><option value="high">high</option></select>{children}</div>;
          export const SelectTrigger = ({ children, ...props }) => <div {...props}>{children}</div>;
          export const SelectValue = () => null;
          export const SelectContent = () => null;
          export const SelectItem = () => null;
        ` };
      });
    },
  }],
});
const { default: Modal, Summary } = await import(pathToFileURL(bundlePath).href);
const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch; dom.window.close();
  await unlink(bundlePath);
  await unlink(bundlePath.replace(/\.mjs$/, ".css")).catch(error => { if (error.code !== "ENOENT") throw error; });
});
const fixtureCard = { id: "card-a", board_id: "board-a", title: "Plan launch", description: "", list_id: "list-a", start_date: "2026-10-08", due_date: "2026-10-12", cover_image: "stale-cover", project_card_label: [] };
const fixtureLabels = [{ id: "label-a", name: "Review", color: "#14b8a6" }];
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); }); }
async function mount(overrides = {}, fixture = {}) {
  globalThis.cardMentionErrors = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const detail = { card: { ...fixtureCard, cover_image: "live-cover" }, comments: [{ id: "comment-a", identity_id: "member-a", content: "Ready for review", created_at: "2026-10-09T12:30:00Z" }], activity: [{ id: "activity-a", identity_id: "member-a", action_type: "moved", action_data: { to_list: "list-a" }, created_at: "2026-10-09T12:30:00Z" }], attachments: [] };
  const calls = [], updates = [];
  const props = {
    card: fixtureCard, open: true, onOpenChange: () => {}, boardId: "board-a", labels: fixtureLabels,
    members: [{ identity_id: "member-a", first_name: "Maya", last_name: "Stone" }],
    lists: [{ id: "list-a", name: "Planning" }], canEdit: true, canManage: true,
    canManageLabels: true, onUpdate: async (patch) => { updates.push(patch); }, onDelete: async () => {},
    ...overrides,
  };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET", body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body, credentials: options.credentials });
    if (fixture.respond) {
      const response = fixture.respond(url, options, detail);
      if (response !== undefined) return await response;
    }
    let result;
    if (url === "/api/projects/cards/card-a" && method === "GET") result = detail;
    else if (url === "/api/projects/boards/board-a/inbox" && method === "PATCH") result = { success: true };
    else if (url === "/api/projects/boards/board-a/labels") result = method === "DELETE" ? { success: true } : { label: { ...body, id: body.id || "label-new", board_id: "board-a" } };
    else if (url === "/api/projects/cards/card-a/labels") {
      const remaining = detail.card.project_card_label.filter((entry) => entry.label_id !== body.label_id);
      detail.card.project_card_label = method === "POST" ? [...remaining, { label_id: body.label_id }] : remaining;
      result = { success: true };
    }
    else throw new Error(`Unexpected fixture request: ${method} ${url}`);
    return { ok: true, status: 200, json: async () => structuredClone(result) };
  };
  client.setQueryData(["project-board", "board-a"], { labels: fixtureLabels, cards: [fixtureCard] });
  client.setQueryData(["card-detail", "other-card"], { card: { ...fixtureCard, id: "other-card", project_card_label: [{ label_id: "label-a" }] } });
  client.setQueryData(["board-inbox", "board-a", "summary"], { unreadCardIds: ["card-a", "other-card"] });
  if (fixture.seedDetail) client.setQueryData(["card-detail", "card-a"], fixture.seedDetail);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function WithTile(nextProps) {
    const summary = useQuery({ queryKey: ["board-inbox", "board-a", "summary"], enabled: false });
    return React.createElement(React.Fragment, null,
      React.createElement(Summary, { card: nextProps.card, hasUnreadMention: summary.data?.unreadCardIds.includes(nextProps.card.id) }),
      React.createElement(Modal, nextProps));
  }
  const render = async () => { await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(QueryClientProvider, { client }, React.createElement(fixture.showTile ? WithTile : Modal, props)))); }); await settle(); };
  await render();
  return {
    container, client, calls, updates, props, detail, render,
    close: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}
async function click(container, selector) {
  const button = container.querySelector(selector); assert.ok(button, selector);
  await act(async () => button.click()); await settle();
}
async function type(container, selector, value) {
  const input = container.querySelector(selector); assert.ok(input, selector);
  const prototype = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

test("wide two-pane modal resolves raw comment/activity identities and uses the live detail cover", async () => {
  const app = await mount();
  try {
    const modal = app.container.querySelector('[data-testid="card-detail-modal"]');
    assert.match(modal.className, /max-w-\[1180px\]/);
    assert.ok([...modal.querySelectorAll("div")].some((element) => element.className.includes("md:grid-cols")));
    assert.ok(app.container.querySelector('section[aria-label="Card details"]'));
    assert.ok(app.container.querySelector('aside[aria-label="Comments and activity"]'));
    assert.match(app.container.textContent, /Maya Stone moved this card to Planning/);
    assert.match(app.container.textContent, /Ready for review/);
    assert.equal(app.container.querySelector('[data-testid="fixture-cover"]').dataset.cover, "live-cover");
    assert.equal(app.container.querySelector('[data-testid="fixture-attachments"]').dataset.cover, "live-cover");
    assert.equal(app.container.querySelectorAll('[data-testid="fixture-cover"]').length, 1);
    assert.equal(app.container.querySelector('[data-testid="fixture-cover"]').dataset.presentation, "header");
    assert.equal(app.container.querySelector('section [data-testid="fixture-cover"]'), null);
    await click(app.container, 'aside button');
    assert.equal(app.container.querySelector('[data-testid="card-activity-entry"]'), null);
  } finally { await app.close(); }
});

test("dirty title survives detail refresh; untouched dates refresh and cleared dates save as null", async () => {
  const app = await mount();
  try {
    await type(app.container, '[data-testid="input-card-title"]', "My unsaved title");
    await type(app.container, '[data-testid="input-start-date"]', "");
    await act(async () => app.client.setQueryData(["card-detail", "card-a"], {
      ...app.detail, card: { ...app.detail.card, title: "Remote title", start_date: "2026-11-02", due_date: "2026-11-04", description: "Remote description" },
    }));
    await settle();
    assert.equal(app.container.querySelector('[data-testid="input-card-title"]').value, "My unsaved title");
    assert.equal(app.container.querySelector('[data-testid="input-start-date"]').value, "");
    assert.equal(app.container.querySelector('[data-testid="input-due-date"]').value, "2026-11-04");
    assert.equal(app.container.querySelector('[data-testid="input-card-description"]').value, "Remote description");
    await type(app.container, '[data-testid="input-due-date"]', "");
    await click(app.container, '[data-testid="button-save-card"]');
    assert.deepEqual(app.updates, [{ title: "My unsaved title", start_date: null, due_date: null }]);
  } finally { await app.close(); }
});

test("create, edit, attach, detach and delete board labels publish confirmed data without new parent props", async () => {
  const app = await mount();
  const confirmations = [], oldConfirm = window.confirm;
  window.confirm = (message) => { confirmations.push(message); return false; };
  try {
    await click(app.container, '[data-testid="button-add-label"]');
    await click(app.container, '[data-testid="button-create-label"]');
    await type(app.container, '[aria-label="Label name"]', "Editorial");
    await click(app.container, '[data-testid="button-save-label"]');
    assert.match(app.container.textContent, /Editorial/);
    assert.ok(app.client.getQueryData(["project-board", "board-a"]).labels.some((label) => label.name === "Editorial"));
    await click(app.container, '[aria-label="Edit Editorial"]');
    await type(app.container, '[aria-label="Label name"]', "Final review");
    await click(app.container, '[data-testid="button-save-label"]');
    assert.ok(app.client.getQueryData(["project-board", "board-a"]).labels.some((label) => label.name === "Final review"));
    const toggle = [...app.container.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent === "Final review");
    await act(async () => toggle.click());
    await settle();
    assert.equal(app.calls.find((call) => call.url.endsWith("/card-a/labels")).method, "POST");
    await click(app.container, '[aria-label="Remove label Final review"]');
    await settle();
    assert.ok(app.calls.some((call) => call.url.endsWith("/card-a/labels") && call.method === "DELETE"));
    await click(app.container, '[aria-label="Delete label Review"]');
    assert.match(confirmations[0], /removed from all cards on this board/);
    assert.equal(app.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/board-a/labels")), false);
    window.confirm = (message) => { confirmations.push(message); return true; };
    await click(app.container, '[aria-label="Delete label Review"]');
    assert.equal(app.container.querySelector('[aria-label="Edit Review"]'), null);
    assert.deepEqual(app.client.getQueryData(["card-detail", "other-card"]).card.project_card_label, []);
    assert.ok(app.calls.every((call) => call.credentials === "include"));
  } finally { window.confirm = oldConfirm; await app.close(); }
});

test("label management is independent of attachment permission; members cannot manage board labels", async () => {
  const manager = await mount({ canEdit: false, canManageLabels: true });
  try {
    await click(manager.container, '[data-testid="button-add-label"]');
    assert.ok(manager.container.querySelector('[data-testid="button-create-label"]'));
    assert.equal(manager.container.querySelector('button[aria-pressed]').disabled, true);
    assert.equal(manager.container.querySelector('[data-testid="button-save-card"]'), null);
  } finally { await manager.close(); }
  const member = await mount({ canManageLabels: false, canManage: false });
  try {
    await click(member.container, '[data-testid="button-add-label"]');
    assert.equal(member.container.querySelector('[data-testid="button-create-label"]'), null);
    assert.equal(member.container.querySelector('[aria-label="Edit Review"]'), null);
    assert.equal(member.container.querySelector('button[aria-pressed]').disabled, false);
  } finally { await member.close(); }
});

test("cover callback propagates PATCH rejection to attachments instead of swallowing it", async () => {
  globalThis.coverError = null;
  const app = await mount({ onUpdate: async () => { throw new Error("Cover permission denied"); } });
  try {
    await click(app.container, '[data-testid="fixture-cover"]');
    assert.equal(globalThis.coverError, "Cover permission denied");
    assert.equal(app.container.querySelector('[data-testid="fixture-cover"]').dataset.cover, "live-cover");
  } finally { await app.close(); delete globalThis.coverError; }
});

test("card deletion uses the shared confirmation with its title; Cancel never deletes or closes details", async () => {
  let deletions = 0;
  const closed = [];
  const oldConfirm = window.confirm;
  window.confirm = () => { assert.fail("Card deletion must not use browser confirmation"); };
  const app = await mount({ onDelete: async () => { deletions++; }, onOpenChange: (value) => closed.push(value) });
  try {
    await click(app.container, '[data-testid="button-delete-card"]');
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog, "real shared AlertDialog is mounted");
    assert.match(dialog.textContent, /Plan launch/);
    assert.match(dialog.textContent, /cannot be undone/);
    assert.equal(deletions, 0);
    assert.match(dialog.querySelector('[data-testid="button-confirm-delete-card"]').className, /bg-destructive/);
    await click(document, '[data-testid="button-cancel-delete-card"]');
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.ok(app.container.querySelector('[data-testid="card-detail-modal"]'));
    assert.equal(deletions, 0);
    assert.deepEqual(closed, []);
  } finally { window.confirm = oldConfirm; await app.close(); }
});

test("pending card deletion guards repeated clicks, Cancel and Escape; only success closes", async () => {
  let resolveDelete, deletions = 0;
  const closed = [];
  const app = await mount({
    onDelete: () => { deletions++; return new Promise((resolve) => { resolveDelete = resolve; }); },
    onOpenChange: (value) => closed.push(value),
  });
  try {
    await click(app.container, '[data-testid="button-delete-card"]');
    const action = document.querySelector('[data-testid="button-confirm-delete-card"]');
    await act(async () => { action.click(); action.click(); });
    await settle();
    assert.equal(deletions, 1);
    assert.equal(action.disabled, true);
    assert.equal(action.textContent, "Deleting…");
    assert.equal(document.querySelector('[data-testid="button-cancel-delete-card"]').disabled, true);
    await click(document, '[data-testid="button-cancel-delete-card"]');
    await act(async () => {
      action.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.ok(document.querySelector('[role="alertdialog"]'));
    assert.deepEqual(closed, []);
    await act(async () => resolveDelete());
    await settle();
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.deepEqual(closed, [false]);
  } finally { await app.close(); }
});

test("failed card deletion keeps confirmation, error feedback and draft; retry succeeds", async () => {
  let deletions = 0;
  const closed = [];
  const app = await mount({
    onDelete: async () => { if (++deletions === 1) throw new Error("Delete permission denied"); },
    onOpenChange: (value) => closed.push(value),
  });
  try {
    await type(app.container, '[data-testid="input-card-title"]', "Unsaved launch plan");
    await click(app.container, '[data-testid="button-delete-card"]');
    await click(document, '[data-testid="button-confirm-delete-card"]');
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    assert.equal(dialog.querySelector('[role="alert"]').textContent, "Delete permission denied");
    assert.equal(dialog.querySelector('[data-testid="button-confirm-delete-card"]').disabled, false);
    assert.equal(dialog.querySelector('[data-testid="button-cancel-delete-card"]').disabled, false);
    assert.equal(app.container.querySelector('[data-testid="input-card-title"]').value, "Unsaved launch plan");
    assert.deepEqual(closed, []);
    await click(document, '[data-testid="button-confirm-delete-card"]');
    assert.equal(deletions, 2);
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.deepEqual(closed, [false]);
  } finally { await app.close(); }
});

test("completion circle and due date pill follow reversible drafts without writing until save", async () => {
  const app = await mount();
  try {
    const toggle = app.container.querySelector('[data-testid="button-toggle-card-complete"]');
    assert.equal(toggle.getAttribute("role"), "checkbox");
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(app.container.querySelector('[data-testid="card-complete-pill"]'), null);
    await click(app.container, '[data-testid="button-toggle-card-complete"]');
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.match(toggle.className, /bg-\[#5a7f23\]/);
    assert.ok(toggle.querySelector("svg"));
    assert.equal(app.container.querySelector('[data-testid="card-complete-pill"]').textContent, "Complete");
    assert.deepEqual(app.updates, []);
    // Remote refresh cannot overwrite the completion draft.
    await act(async () => app.client.setQueryData(["card-detail", "card-a"], {
      ...app.detail, card: { ...app.detail.card, is_complete: false },
    }));
    await settle();
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await click(app.container, '[data-testid="button-toggle-card-complete"]');
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(app.container.querySelector('[data-testid="card-complete-pill"]'), null);
    await click(app.container, '[data-testid="button-toggle-card-complete"]');
    await click(app.container, '[data-testid="button-save-card"]');
    assert.deepEqual(app.updates, [{ is_complete: true }]);
  } finally { await app.close(); }
});

test("completed read-only cards show the tick and Complete pill but cannot toggle or change cover", async () => {
  const app = await mount({ card: { ...fixtureCard, is_complete: true }, canEdit: false, canManage: false, canManageLabels: false });
  try {
    const toggle = app.container.querySelector('[data-testid="button-toggle-card-complete"]');
    assert.equal(toggle.disabled, true);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.ok(toggle.querySelector("svg"));
    assert.equal(app.container.querySelector('[data-testid="card-complete-pill"]').textContent, "Complete");
    assert.equal(app.container.querySelector('[data-testid="fixture-cover"]').disabled, true);
    await click(app.container, '[data-testid="button-toggle-card-complete"]');
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.deepEqual(app.updates, []);
  } finally { await app.close(); }
});

test("a completed card can be reopened as a draft and saves false", async () => {
  const app = await mount({ card: { ...fixtureCard, is_complete: true } });
  try {
    await click(app.container, '[data-testid="button-toggle-card-complete"]');
    assert.equal(app.container.querySelector('[data-testid="card-complete-pill"]'), null);
    await click(app.container, '[data-testid="button-save-card"]');
    assert.deepEqual(app.updates, [{ is_complete: false }]);
  } finally { await app.close(); }
});

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const readCalls = (app) => app.calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/inbox"));
async function until(predicate) {
  for (let i = 0; i < 60; i++) { if (predicate()) return; await settle(); }
  assert.fail("Timed out waiting for mention lifecycle");
}

test("opening reads once, removes confirmed summary entry, invalidates both inboxes, and reopening reads again", async () => {
  let finishPatch;
  const app = await mount({}, {
    showTile: true,
    respond: (url, options) => options.method === "PATCH" && url.endsWith("/inbox")
      ? new Promise((resolve) => { finishPatch = resolve; }) : undefined,
  });
  try {
    await until(() => readCalls(app).length === 1);
    assert.deepEqual(readCalls(app)[0].body, { cardId: "card-a", read: true });
    assert.deepEqual(app.client.getQueryData(["board-inbox", "board-a", "summary"]).unreadCardIds, ["card-a", "other-card"], "not optimistically cleared");
    assert.ok(app.container.querySelector('[data-testid="tile-mention-badge"]'));
    const invalidations = [];
    const invalidate = app.client.invalidateQueries.bind(app.client);
    app.client.invalidateQueries = (options) => { invalidations.push(options); return invalidate(options); };
    await act(async () => finishPatch(response({ success: true })));
    await until(() => invalidations.length >= 4);
    assert.deepEqual(app.client.getQueryData(["board-inbox", "board-a", "summary"]).unreadCardIds, ["other-card"]);
    assert.equal(app.container.querySelector('[data-testid="tile-mention-badge"]'), null, "mounted tile updates on confirmed read");
    assert.ok(invalidations.some(({ queryKey, exact }) => exact && queryKey.length === 1 && queryKey[0] === "inbox"));
    assert.ok(invalidations.some(({ queryKey }) => queryKey[1] === "unread"));
    assert.ok(invalidations.some(({ queryKey }) => queryKey[1] === "search"));
    assert.ok(invalidations.some(({ queryKey }) => queryKey[0] === "board-inbox" && queryKey[1] === "board-a"));
    await act(async () => app.client.invalidateQueries({ queryKey: ["card-detail", "card-a"] }));
    await settle();
    assert.equal(readCalls(app).length, 1, "detail/inbox invalidations do not loop");
    app.props.open = false; await app.render();
    app.props.open = true; await app.render();
    await until(() => readCalls(app).length === 2);
    await act(async () => finishPatch(response({ success: true })));
  } finally { await app.close(); }
});

test("list/cache props do not read before a successful detail GET; closed modal never reads", async () => {
  let finishDetail;
  const app = await mount({ open: false }, {
    seedDetail: { card: { ...fixtureCard, id: "wrong-card" } },
    respond: (url, options) => url === "/api/projects/cards/card-a" && !options.method
      ? new Promise((resolve) => { finishDetail = resolve; }) : undefined,
  });
  try {
    assert.equal(app.calls.length, 0);
    app.props.open = true; await app.render();
    assert.equal(readCalls(app).length, 0, "cached different-card detail is not accepted");
    await act(async () => finishDetail(response(app.detail)));
    await until(() => readCalls(app).length === 1);
  } finally { await app.close(); }
});

test("switching cards ignores a late previous detail and uses the loaded card's board on the Sales surface", async () => {
  const pending = {};
  const app = await mount({}, {
    respond: (url, options) => {
      if (!options.method && url.startsWith("/api/projects/cards/")) return new Promise((resolve) => { pending[url.split("/").at(-1)] = resolve; });
      if (options.method === "PATCH" && url.endsWith("/inbox")) return response({ success: true });
    },
  });
  try {
    app.props.card = { id: "card-b", title: "Sales task" };
    app.props.boardId = undefined;
    await app.render();
    await act(async () => pending["card-a"](response(app.detail)));
    await settle();
    assert.equal(readCalls(app).length, 0, "previous GET cannot mark either card");
    await act(async () => pending["card-b"](response({ card: { ...fixtureCard, id: "card-b", board_id: "board-b" } })));
    await until(() => readCalls(app).length === 1);
    assert.equal(readCalls(app)[0].url, "/api/projects/boards/board-b/inbox");
    assert.deepEqual(readCalls(app)[0].body, { cardId: "card-b", read: true });
    assert.equal(readCalls(app)[0].credentials, "include");
  } finally { await app.close(); }
});

test("failed detail GET never marks read; detail retry can mark once the current card loads", async () => {
  let fail = true;
  const app = await mount({}, {
    respond: (url, options, detail) => !options.method && url === "/api/projects/cards/card-a"
      ? response(fail ? { error: "Not allowed" } : detail, fail ? 403 : 200) : undefined,
  });
  try {
    await until(() => app.client.getQueryState(["card-detail", "card-a"]).status === "error");
    assert.equal(readCalls(app).length, 0);
    assert.deepEqual(app.client.getQueryData(["board-inbox", "board-a", "summary"]).unreadCardIds, ["card-a", "other-card"]);
    fail = false;
    await act(async () => app.client.refetchQueries({ queryKey: ["card-detail", "card-a"] }));
    await until(() => readCalls(app).length === 1);
  } finally { await app.close(); }
});

test("PATCH failures preserve unread bells, offer meaningful retry, and do not automatically loop", async () => {
  let fail = true;
  const app = await mount({}, {
    showTile: true,
    respond: (url, options) => options.method === "PATCH" && url.endsWith("/inbox")
      ? response(fail ? { error: "Service unavailable" } : { success: true }, fail ? 503 : 200) : undefined,
  });
  try {
    await until(() => globalThis.cardMentionErrors.length === 1);
    const [message, options] = globalThis.cardMentionErrors[0];
    assert.match(message, /remain unread in both inboxes/);
    assert.equal(options.action.label, "Retry");
    assert.deepEqual(app.client.getQueryData(["board-inbox", "board-a", "summary"]).unreadCardIds, ["card-a", "other-card"]);
    assert.ok(app.container.querySelector('[data-testid="tile-mention-badge"]'), "failed PATCH retains the mounted bell");
    await act(async () => app.client.refetchQueries({ queryKey: ["card-detail", "card-a"] }));
    await settle();
    assert.equal(readCalls(app).length, 1);
    fail = false;
    await act(async () => options.action.onClick());
    await until(() => app.client.getQueryData(["board-inbox", "board-a", "summary"]).unreadCardIds.length === 1);
    assert.equal(readCalls(app).length, 2);
    await act(async () => options.action.onClick());
    assert.equal(readCalls(app).length, 2, "stale retry cannot read twice");
  } finally { await app.close(); }
});

test("retry from an old opening is inert after closing or switching cards", async () => {
  const app = await mount({}, {
    respond: (url, options) => options.method === "PATCH" && url.endsWith("/inbox")
      ? response({ error: "Unavailable" }, 503) : undefined,
  });
  try {
    await until(() => globalThis.cardMentionErrors.length === 1);
    const retry = globalThis.cardMentionErrors[0][1].action.onClick;
    app.props.open = false; await app.render();
    await act(async () => retry());
    assert.equal(readCalls(app).length, 1);
    app.props.card = { id: "card-b", title: "Another task" };
    app.props.open = true; await app.render();
    await act(async () => retry());
    assert.equal(readCalls(app).length, 1);
  } finally { await app.close(); }
});
