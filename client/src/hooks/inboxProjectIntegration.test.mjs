import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Isolated React hooks with fixture-only HTTP. No tenant services or database.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const bundlePath = path.resolve(`client/src/hooks/.inbox-fixture-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export { useInbox, fetchInboxMessageBody, useInboxUnreadSummary } from "./hooks/useInbox.js";
      export { useBoardInbox } from "./components/projects/useBoardInbox.js";
      export { useInboxCardDeepLink } from "./components/projects/useInboxCardDeepLink.js";
    `,
    resolveDir: path.resolve("client/src"),
  },
  outfile: bundlePath, bundle: true, format: "esm", platform: "node", packages: "external",
  alias: { "@": path.resolve("client/src") }, logLevel: "silent",
  plugins: [{
    name: "no-tenant-client",
    setup(builder) {
      builder.onResolve({ filter: /api\/base44Client$/ }, () => ({ path: "base44", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export const base44 = { entities: {} };",
      }));
    },
  }],
});
const { useInbox, useBoardInbox, useInboxCardDeepLink, fetchInboxMessageBody, useInboxUnreadSummary } = await import(pathToFileURL(bundlePath).href);
const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  dom.window.close();
  await unlink(bundlePath);
});
const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function mount(Component, props = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const render = async (nextProps) => {
    await React.act(async () => {
      root.render(React.createElement(React.StrictMode, null,
        React.createElement(QueryClientProvider, { client }, React.createElement(Component, nextProps))));
      await wait();
    });
    await React.act(wait);
  };
  await render(props);
  return {
    client, render,
    async close() {
      await React.act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

test("main single/mixed actions and board actions mutually invalidate, archive stays non-destructive", async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    requests.push({ url, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
    if (url === "/api/communication/inbox" && !options.method) return json({ messages: [], folders: [], unreadCount: 1 });
    if (url === "/api/communication/inbox" && options.method === "POST") return json({ success: true });
    if (url === "/api/projects/boards/b/inbox" && options.method === "PATCH") return json({ success: true });
    if (url === "/api/communication/inbox/m?source=project") return json({ message: { recipient_id: "m", source: "project" } });
    if (url === "/api/communication/inbox/unread-count") return json({ unreadCount: 1, latestMessageId: "m", latestSource: "project" });
    throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
  };
  let main, board, badge;
  function Harness() {
    main = useInbox();
    board = useBoardInbox("b", 1, false);
    badge = useInboxUnreadSummary();
    return null;
  }
  const mounted = await mount(Harness);
  try {
    assert.equal(badge.latestSource, "project");
    const invalidations = [];
    const original = mounted.client.invalidateQueries.bind(mounted.client);
    mounted.client.invalidateQueries = (options) => { invalidations.push(options); return original(options); };
    const assertInvalidated = () => {
      assert.ok(invalidations.some((item) => item.queryKey[0] === "board-inbox"));
      assert.ok(invalidations.some((item) => item.exact && item.queryKey.length === 1 && item.queryKey[0] === "inbox"));
      assert.ok(invalidations.some((item) => item.queryKey[1] === "unread"));
      assert.ok(invalidations.some((item) => item.queryKey[1] === "search"));
      invalidations.length = 0;
    };
    await React.act(async () => { await main.act("m", "archive", undefined, "project"); });
    assert.deepEqual(requests.find((request) => request.method === "POST").body, { action: "archive", project_id: "m" });
    assertInvalidated();
    await React.act(async () => { await main.actBulk(["m"], ["m"], "move", "folder", ["m"]); });
    assert.deepEqual(requests.filter((request) => request.method === "POST").at(-1).body, {
      action: "move", folder_id: "folder", recipient_ids: ["m"], transactional_ids: ["m"], project_ids: ["m"],
    });
    assertInvalidated();
    await React.act(async () => { await board.command.mutateAsync({ ids: ["m"], read: true }); });
    assertInvalidated();
    assert.equal((await fetchInboxMessageBody("m", "project")).source, "project");
    assert.ok(!requests.some((request) => request.method === "DELETE"));
    assert.equal(mounted.client.getQueryCache().find({ queryKey: ["inbox"], exact: true }).options.refetchInterval, 30000);
    assert.equal(mounted.client.getQueryCache().find({ queryKey: ["inbox"], exact: true }).options.refetchIntervalInBackground, false);
  } finally { await mounted.close(); }
});

test("deep links recheck authentication, do not reopen after close or steal manual opens", async () => {
  const opened = [];
  const requests = [];
  let resolvePending;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.credentials, "include");
    requests.push(url);
    if (url.endsWith("/pending")) return new Promise((resolve) => { resolvePending = resolve; });
    const id = url.split("/").at(-1);
    return json({ card: { id, board_id: "b" } });
  };
  let link;
  function Harness(props) {
    link = useInboxCardDeepLink({ ...props, onOpenCard: (card) => opened.push(card.id) });
    return null;
  }
  const props = { boardId: "b", search: "?cardId=c", ready: false };
  const mounted = await mount(Harness, props);
  try {
    assert.equal(requests.length, 0, "no requests before authorized board is ready");
    await mounted.render({ ...props, ready: true });
    assert.deepEqual(opened, ["c"]);
    await React.act(async () => link.cancel());
    await mounted.render({ ...props, ready: true });
    assert.deepEqual(opened, ["c"], "closing does not reopen");
    await mounted.render({ ...props, search: "?cardId=pending", ready: true });
    await React.act(async () => link.cancel()); // manual open/close cancels link
    await React.act(async () => { resolvePending(json({ card: { id: "pending", board_id: "b" } })); await wait(); });
    assert.deepEqual(opened, ["c"], "late response cannot replace a manual open");
    await mounted.render({ ...props, search: "?cardId=next", ready: true });
    assert.deepEqual(opened, ["c", "next"]);
    await React.act(async () => link.cancel());
    await mounted.render({ ...props, search: "", ready: true });
    await mounted.render({ ...props, search: "?cardId=next", ready: true });
    assert.deepEqual(opened, ["c", "next", "next"], "explicit new navigation can open the same card again");
  } finally { await mounted.close(); }
});

test("deep links reject mismatched/archived cards and present permission errors with retry", async () => {
  const opened = [];
  let response = { card: { id: "c", board_id: "other" } };
  let status = 200;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.credentials, "include");
    return json(response, status);
  };
  let link;
  function Harness(props) {
    link = useInboxCardDeepLink({ ...props, onOpenCard: (card) => opened.push(card.id) });
    return null;
  }
  const mounted = await mount(Harness, { boardId: "b", search: "?cardId=c", ready: true });
  try {
    assert.match(link.error, /no longer on this board/);
    response = { card: { id: "c", board_id: "b", is_archived: true } };
    await React.act(async () => { link.retry(); await wait(); });
    await React.act(wait);
    assert.match(link.error, /archived/);
    response = { error: "Forbidden" }; status = 403;
    await React.act(async () => { link.retry(); await wait(); });
    await React.act(wait);
    assert.match(link.error, /no longer have access/);
    assert.deepEqual(opened, []);
    response = { card: { id: "c", board_id: "b" } }; status = 200;
    await React.act(async () => { link.retry(); await wait(); });
    await React.act(wait);
    assert.deepEqual(opened, ["c"]);
    assert.equal(link.error, "");
  } finally { await mounted.close(); }
});
