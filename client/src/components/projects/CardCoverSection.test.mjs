import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider, useQuery } = await import("@tanstack/react-query");
const bundlePath = path.resolve(`client/src/components/projects/.cover-fixture-${process.pid}.mjs`);
await build({
  entryPoints: ["client/src/components/projects/CardAttachments.jsx"], outfile: bundlePath,
  bundle: true, format: "esm", platform: "node", packages: "external", jsx: "transform",
  alias: { "@": path.resolve("client/src") }, define: { "import.meta.env": "{}" }, logLevel: "silent",
  plugins: [{
    name: "cover-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /^(@\/components\/ui\/dialog|sonner)$/ },
        ({ path: entry }) => ({ path: entry, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: entry }) => ({
        loader: "jsx", contents: entry === "sonner" ? `
          export const toast = { success: message => globalThis.coverToasts.push(message), error: () => {} };
        ` : `
          export const Dialog = ({ open, children }) => open ? <div data-testid="picker">{children}</div> : null;
          export const DialogContent = ({ children, ...props }) => <div {...props}>{children}</div>;
          export const DialogHeader = ({ children }) => <header>{children}</header>;
          export const DialogTitle = ({ children }) => <h1>{children}</h1>;
        `,
      }));
    },
  }],
});
const { CardCoverSection } = await import(pathToFileURL(bundlePath).href);
const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  delete globalThis.coverToasts;
  dom.window.close();
  await unlink(bundlePath);
});
const attachment = { id: "image-a", name: "Meeting.png", url: "https://fixture.invalid/attachment.png", file_type: "image/png" };
const newCover = "https://fixture.invalid/cover.webp";
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data, text: async () => JSON.stringify(data) });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }
async function click(app, selector) {
  const button = app.container.querySelector(selector);
  assert.ok(button, selector);
  await act(async () => button.click());
  await settle();
}
async function upload(app, file) {
  const input = app.container.querySelector('[data-testid="input-cover-upload"]');
  assert.ok(input);
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
  assert.equal(input.value, "");
}
async function mount({ canEdit = true, attachments = [], coverImage = null, failAt, pausePublish = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const calls = [], callbacks = [];
  globalThis.coverToasts = [];
  client.setQueryData(["card-detail", "card-a"], { card: { id: "card-a", cover_image: coverImage }, attachments });
  client.setQueryData(["project-board", "board-a"], { cards: [{ id: "card-a", cover_image: coverImage, project_card_attachment: attachments }] });
  let release;
  if (pausePublish) {
    const cancel = client.cancelQueries.bind(client);
    client.cancelQueries = async (...args) => { await cancel(...args); await new Promise(resolve => { release = resolve; }); };
  }
  globalThis.fetch = async (url, options = {}) => {
    const body = options.method === "PUT" ? options.body : JSON.parse(options.body || "{}");
    calls.push({ url, ...options, body });
    if (calls.length === failAt) return response({ error: "Cover upload denied" }, false);
    if (url === "/api/projects/cards/card-a/attachments") return response({ signedUrl: "https://storage.invalid/upload", uploadToken: "cover-token" });
    if (url === "https://storage.invalid/upload") return response({});
    if (url === "/api/projects/cards/card-a/attachments/confirm") return response({ coverImage: newCover });
    if (url === "/api/projects/cards/card-a/attachments/image-a") return response({ coverImage: attachment.url });
    if (url === "/api/projects/cards/card-a" && options.method === "PATCH") return response({});
    throw new Error(`Unexpected request ${options.method} ${url}`);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Fixture() {
    const { data } = useQuery({ queryKey: ["card-detail", "card-a"], enabled: false });
    return React.createElement(CardCoverSection, {
      cardId: "card-a", canEdit, attachments: data.attachments, coverImage: data.card.cover_image,
      onCoverChange: value => callbacks.push(value),
    });
  }
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture))));
  return {
    container, client, calls, callbacks, release: () => release(),
    close: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}

test("cover-only upload waits for cache publication, updates mounted cover and board, never adds an attachment or PATCHes", async () => {
  const app = await mount({ pausePublish: true });
  try {
    await click(app, '[data-testid="button-add-cover"]');
    const file = new dom.window.File(["image"], "Cover.webp", { type: "image/webp" });
    await upload(app, file);
    assert.deepEqual(app.calls.map(call => call.method), ["POST", "PUT", "POST"]);
    assert.deepEqual(app.calls[0].body, { fileName: file.name, fileSize: file.size, mimeType: file.type, purpose: "cover" });
    assert.equal(app.calls[0].credentials, "include");
    assert.equal(app.calls[1].body, file);
    assert.equal(app.calls[1].headers["Content-Type"], "image/webp");
    assert.deepEqual(app.calls[2].body, { uploadToken: "cover-token" });
    assert.equal(app.calls[2].credentials, "include");
    assert.ok(app.container.querySelector('[data-testid="picker"]'));
    assert.equal(app.container.querySelector('[data-testid="button-upload-cover"]').disabled, true);
    assert.equal(app.container.querySelector('[data-testid="button-add-cover"]').disabled, true);
    assert.deepEqual(globalThis.coverToasts, []);
    await act(async () => app.release());
    await settle();
    assert.equal(app.container.querySelector('[data-testid="picker"]'), null);
    assert.equal(app.container.querySelector('img[alt="Card cover"]').src, newCover);
    assert.equal(app.client.getQueryData(["project-board", "board-a"]).cards[0].cover_image, newCover);
    assert.deepEqual(app.client.getQueryData(["project-board", "board-a"]).cards[0].project_card_attachment, []);
    assert.deepEqual(app.client.getQueryData(["card-detail", "card-a"]).attachments, []);
    assert.deepEqual(app.callbacks, []);
    assert.deepEqual(globalThis.coverToasts, ["Cover image uploaded"]);
  } finally { await app.close(); }
});

for (const failAt of [1, 2, 3]) {
  test(`upload failure at step ${failAt} keeps picker open and old cover, and permits retry`, async () => {
    const app = await mount({ coverImage: attachment.url, failAt });
    try {
      await click(app, '[data-testid="button-change-cover"]');
      const file = new dom.window.File(["image"], "Cover.png", { type: "image/png" });
      await upload(app, file);
      assert.ok(app.container.querySelector('[role="alert"]'));
      assert.equal(app.container.querySelector('img[alt="Card cover"]').src, attachment.url);
      assert.equal(app.container.querySelector('[data-testid="button-upload-cover"]').disabled, false);
      assert.equal(app.calls.length, failAt);
      assert.deepEqual(globalThis.coverToasts, []);
      await upload(app, file);
      assert.equal(app.container.querySelector('[data-testid="picker"]'), null);
      assert.equal(app.container.querySelector('img[alt="Card cover"]').src, newCover);
    } finally { await app.close(); }
  });
}

test("upload disables attachment selection and removal until the confirmed cover is published", async () => {
  const app = await mount({ attachments: [attachment], coverImage: attachment.url, pausePublish: true });
  try {
    await click(app, '[data-testid="button-change-cover"]');
    await upload(app, new dom.window.File(["image"], "Cover.gif", { type: "image/gif" }));
    assert.equal(app.container.querySelector('[data-testid="cover-option-image-a"]').disabled, true);
    assert.equal(app.container.querySelector('[data-testid="button-remove-cover"]').disabled, true);
    assert.equal(app.container.querySelector('[data-testid="input-cover-upload"]').disabled, true);
    await click(app, '[data-testid="cover-option-image-a"]');
    await click(app, '[data-testid="button-remove-cover"]');
    assert.equal(app.calls.length, 3);
    await act(async () => app.release());
    await settle();
    assert.equal(app.container.querySelector('img[alt="Card cover"]').src, newCover);
    assert.deepEqual(app.client.getQueryData(["card-detail", "card-a"]).attachments, [attachment]);
  } finally { await app.close(); }
});

test("invalid MIME types and images over 100 MB are rejected without requests", async () => {
  const app = await mount();
  try {
    await click(app, '[data-testid="button-add-cover"]');
    await upload(app, new dom.window.File(["svg"], "Cover.svg", { type: "image/svg+xml" }));
    assert.match(app.container.querySelector('[role="alert"]').textContent, /JPEG, PNG, GIF or WebP/);
    await upload(app, { name: "Large.jpg", type: "image/jpeg", size: 100 * 1024 * 1024 + 1 });
    assert.match(app.container.querySelector('[role="alert"]').textContent, /100 MB/);
    assert.deepEqual(app.calls, []);
  } finally { await app.close(); }
});

test("viewers can see existing cover but have no upload, selection or removal controls", async () => {
  for (const coverImage of [null, attachment.url]) {
    const app = await mount({ canEdit: false, coverImage, attachments: [attachment] });
    try {
      assert.equal(app.container.querySelector("button"), null);
      assert.equal(app.container.querySelector("input"), null);
      assert.equal(!!app.container.querySelector("img"), !!coverImage);
      assert.deepEqual(app.calls, []);
    } finally { await app.close(); }
  }
});

test("attachment cover selection and removal still publish confirmed cover", async () => {
  const app = await mount({ attachments: [attachment] });
  try {
    await click(app, '[data-testid="button-add-cover"]');
    await click(app, '[data-testid="cover-option-image-a"]');
    assert.equal(app.container.querySelector('img[alt="Card cover"]').src, attachment.url);
    assert.deepEqual(app.calls[0].body, { setAsCover: true });
    assert.equal(app.calls[0].method, "PATCH");
    await click(app, '[data-testid="button-remove-cover"]');
    assert.equal(app.container.querySelector('img[alt="Card cover"]'), null);
    assert.equal(app.client.getQueryData(["project-board", "board-a"]).cards[0].cover_image, null);
    assert.deepEqual(app.client.getQueryData(["card-detail", "card-a"]).attachments, [attachment]);
    assert.deepEqual(app.callbacks, []);
  } finally { await app.close(); }
});
