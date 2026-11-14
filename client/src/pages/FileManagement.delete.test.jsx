import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.test/admin/files",
});
for (const key of [
  "window", "document", "navigator", "HTMLElement", "Element", "Node",
  "DocumentFragment", "HTMLInputElement", "MutationObserver", "CustomEvent", "Event",
  "MouseEvent", "localStorage", "NodeFilter",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "window" ? dom.window : dom.window[key],
  });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { base44 } = await import("../api/base44Client.js");
const FileManagementPage = (await import("./FileManagement.jsx")).default;

const file = {
  id: "file-1",
  file_name: "annual-report.pdf",
  file_url: "https://files.test/annual-report.pdf",
  file_type: "document",
  file_size: 2048,
  folder_id: null,
  tags: [],
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.equal(String(url), "/api/admin/plan-usage");
  return { ok: true, status: 200, json: async () => ({}) };
};

const entityMethods = [
  ["FileRepository", "list"],
  ["FileRepository", "delete"],
  ["FileRepository", "update"],
  ["FileRepository", "create"],
  ["FileRepositoryFolder", "list"],
  ["FileRepositoryFolder", "delete"],
  ["FileRepositoryFolder", "create"],
  ["SystemSettings", "filter"],
];
const originals = new Map(entityMethods.map(([entity, method]) => [
  `${entity}.${method}`,
  base44.entities[entity][method],
]));

const settle = () => act(async () => {
  await new Promise(resolve => setTimeout(resolve, 20));
});

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(`Timed out waiting for ${message}`);
}

async function mount({ files = [file], folders = [], deleteFile, updateFile, deleteFolder } = {}) {
  let currentFiles = structuredClone(files);
  let fileListCalls = 0;
  base44.entities.FileRepository.list = async ({ offset = 0, limit = 1000 } = {}) => {
    fileListCalls += 1;
    return structuredClone(currentFiles.slice(offset, offset + limit));
  };
  base44.entities.FileRepository.delete = deleteFile || (async id => {
    currentFiles = currentFiles.filter(item => item.id !== id);
  });
  base44.entities.FileRepository.update = updateFile || (async (id, data) => {
    currentFiles = currentFiles.map(item => item.id === id ? { ...item, ...data } : item);
  });
  base44.entities.FileRepositoryFolder.list = async () => structuredClone(folders);
  base44.entities.FileRepositoryFolder.delete = deleteFolder || (async () => {});
  base44.entities.SystemSettings.filter = async () => [];

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <FileManagementPage />
      </QueryClientProvider>
    </MemoryRouter>,
  ));
  await waitFor(() => {
    if (folders.length > 0) return container.querySelector('button[title="Delete folder"]');
    return container.querySelector('[aria-label="Delete annual-report.pdf"]') || files.length === 0;
  }, "file repository data");
  return {
    container,
    client,
    root,
    getFileListCalls: () => fileListCalls,
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

test("file deletion warns about permanent vault removal and cancel sends no DELETE", async () => {
  let deleteCalls = 0;
  let warning;
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = message => {
    warning = message;
    return false;
  };
  const view = await mount({ deleteFile: async () => { deleteCalls += 1; } });
  try {
    await act(async () => view.container.querySelector('[aria-label="Delete annual-report.pdf"]').click());
    assert.equal(
      warning,
      'Permanently delete "annual-report.pdf" from the repository and vault? Links to this file will stop working, including links used on pages or in emails. Downloaded copies cannot be revoked.',
    );
    assert.equal(deleteCalls, 0);
    assert.match(view.container.textContent, /annual-report\.pdf/);
  } finally {
    globalThis.confirm = previousConfirm;
    await view.cleanup();
  }
});

test("confirm deletes the file and successful invalidation refreshes the list", async () => {
  const deletedIds = [];
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  let view;
  view = await mount({
    deleteFile: async id => {
      deletedIds.push(id);
      // Make the subsequent repository read reflect the successful backend delete.
      base44.entities.FileRepository.list = async () => [];
    },
  });
  try {
    await act(async () => view.container.querySelector('[aria-label="Delete annual-report.pdf"]').click());
    await waitFor(
      () => !view.container.querySelector('[aria-label="Delete annual-report.pdf"]'),
      "the refreshed repository",
    );
    assert.deepEqual(deletedIds, ["file-1"]);
    assert.match(view.container.textContent, /No Files Found/);
  } finally {
    globalThis.confirm = previousConfirm;
    await view.cleanup();
  }
});

test("failed deletion leaves the repository record visible", async () => {
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const view = await mount({
    deleteFile: async () => { throw new Error("vault unavailable"); },
  });
  try {
    await act(async () => view.container.querySelector('[aria-label="Delete annual-report.pdf"]').click());
    await settle();
    assert.ok(view.container.querySelector('[aria-label="Delete annual-report.pdf"]'));
    assert.match(view.container.textContent, /annual-report\.pdf/);
  } finally {
    globalThis.confirm = previousConfirm;
    await view.cleanup();
  }
});

test("pending deletion disables delete controls and prevents duplicate requests", async () => {
  let resolveDelete;
  let deleteCalls = 0;
  const pendingDelete = new Promise(resolve => { resolveDelete = resolve; });
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const view = await mount({
    deleteFile: async () => {
      deleteCalls += 1;
      await pendingDelete;
    },
  });
  try {
    const button = view.container.querySelector('[aria-label="Delete annual-report.pdf"]');
    await act(async () => button.click());
    await waitFor(() => button.disabled, "pending delete state");
    await act(async () => button.click());
    assert.equal(deleteCalls, 1);
    await act(async () => resolveDelete());
  } finally {
    globalThis.confirm = previousConfirm;
    await view.cleanup();
  }
});

test("folder deletion still moves nested files to root and deletes children first", async () => {
  const updates = [];
  const deletedFolders = [];
  let prompt;
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = message => {
    prompt = message;
    return true;
  };
  const folders = [
    { id: "parent", name: "Parent", parent_folder_id: null, display_order: 0 },
    { id: "child", name: "Child", parent_folder_id: "parent", display_order: 0 },
  ];
  const nestedFile = { ...file, folder_id: "child" };
  const view = await mount({
    files: [nestedFile],
    folders,
    updateFile: async (id, data) => { updates.push([id, data]); },
    deleteFolder: async id => { deletedFolders.push(id); },
  });
  try {
    const folderDelete = view.container.querySelector('button[title="Delete folder"]');
    assert.ok(folderDelete);
    await act(async () => folderDelete.click());
    await waitFor(() => deletedFolders.length === 2, "recursive folder deletion");
    assert.equal(
      prompt,
      "This folder contains subfolders. All subfolders and their files will be moved to root. Continue?",
    );
    assert.deepEqual(updates, [["file-1", { folder_id: null }]]);
    assert.deepEqual(deletedFolders, ["child", "parent"]);
  } finally {
    globalThis.confirm = previousConfirm;
    await view.cleanup();
  }
});

test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, original] of originals) {
    const [entity, method] = key.split(".");
    base44.entities[entity][method] = original;
  }
  dom.window.close();
});

const clickText = async (container, text) => {
  const button = [...container.querySelectorAll("button")].find(el => el.textContent.trim() === text);
  assert.ok(button, `button ${text}`);
  await act(async () => button.click());
};
const inputText = async (input, text) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
const scopeFolders = [
  { id: "a", name: "Alpha", parent_folder_id: null },
  { id: "b", name: "Beta", parent_folder_id: null },
  { id: "c", name: "Child", parent_folder_id: "a" },
  { id: "d", name: "Deep", parent_folder_id: "c" },
];
const scopeFiles = [
  file,
  { ...file, id: "a1", file_name: "alpha.png", file_type: "image", folder_id: "a", description: "special description" },
  { ...file, id: "b1", file_name: "beta.pdf", folder_id: "b", tags: ["special-tag"] },
  { ...file, id: "d1", file_name: "deep.pdf", folder_id: "d" },
];

test("All files combines root, siblings and deeply nested files with search, types and scope isolation", async () => {
  const view = await mount({ files: scopeFiles, folders: scopeFolders });
  try {
    assert.equal(view.container.querySelectorAll('[aria-label^="Delete "]').length, 1);
    await act(async () => view.container.querySelector('[data-testid="scope-all-files"]').click());
    assert.equal(view.container.querySelectorAll('[aria-label^="Delete "]').length, 4);
    assert.match(view.container.textContent, /Showing 1-4 of 4 files/);
    const search = view.container.querySelector('input[placeholder="Search files..."]');
    for (const [term, name] of [["DEEP", "deep.pdf"], ["description", "alpha.png"], ["special-tag", "beta.pdf"]]) {
      await inputText(search, term);
      assert.equal(view.container.querySelectorAll('[aria-label^="Delete "]').length, 1);
      assert.ok(view.container.querySelector(`[aria-label="Delete ${name}"]`));
    }
    await inputText(search, "");
    const images = [...view.container.querySelectorAll('[role="tab"]')].find(el => el.textContent === "Images");
    await act(async () => images.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 })));
    assert.equal(view.container.querySelectorAll('[aria-label^="Delete "]').length, 1);
    const all = [...view.container.querySelectorAll('[role="tab"]')].find(el => el.textContent === "All");
    await act(async () => all.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 })));
    await clickText(view.container, "Bulk Move Mode");
    await clickText(view.container, "Select All");
    assert.match(view.container.textContent, /4 files selected/);
    await act(async () => view.container.querySelector('[data-testid="scope-root"]').click());
    assert.match(view.container.textContent, /Select files below/);
    assert.equal(view.container.querySelectorAll('[aria-label^="Delete "]').length, 1);
    await act(async () => [...view.container.querySelectorAll("span")].find(el => el.textContent === "Beta").click());
    assert.ok(view.container.querySelector('[aria-label="Delete beta.pdf"]'));
    assert.equal(view.container.querySelectorAll('[aria-label^="Delete "]').length, 1);
  } finally { await view.cleanup(); }
});

test("complete collection loads beyond the server cap and paginates combined results", async () => {
  window.scrollTo = () => {};
  const files = Array.from({ length: 1001 }, (_, i) => ({
    ...file, id: `f-${i}`, file_name: `file-${i}.pdf`, folder_id: i ? "d" : null,
  }));
  const view = await mount({ files, folders: scopeFolders });
  try {
    await act(async () => view.container.querySelector('[data-testid="scope-all-files"]').click());
    assert.equal(view.getFileListCalls(), 2);
    assert.match(view.container.textContent, /Showing 1-12 of 1001 files/);
    await clickText(view.container, "2");
    assert.match(view.container.textContent, /Showing 13-24 of 1001 files/);
    await inputText(view.container.querySelector('input[placeholder="Search files..."]'), "file-1000.pdf");
    assert.match(view.container.textContent, /Showing 1-1 of 1 files/);
    assert.ok(view.container.querySelector('[aria-label="Delete file-1000.pdf"]'));
  } finally { await view.cleanup(); }
});

test("All files creates folders and uploads at Root, and bulk moves only to real destinations", async () => {
  const moves = [];
  const createdFolders = [];
  const createdFiles = [];
  const view = await mount({ files: scopeFiles, folders: scopeFolders, updateFile: async (...args) => moves.push(args) });
  base44.entities.FileRepositoryFolder.create = async data => { createdFolders.push(data); return data; };
  base44.entities.FileRepository.create = async data => { createdFiles.push(data); return data; };
  const fetchBefore = globalThis.fetch;
  const xhrBefore = globalThis.XMLHttpRequest;
  globalThis.fetch = async url => String(url) === "/api/storage/signed-upload-url"
    ? { ok: true, json: async () => ({ signedUrl: "https://files.test/upload", fileUrl: "https://files.test/new.pdf", path: "new.pdf", bucket: "uploads" }) }
    : fetchBefore(url);
  globalThis.XMLHttpRequest = class {
    status = 200;
    upload = { addEventListener() {} };
    addEventListener(event, handler) { if (event === "load") this.loaded = handler; }
    open() {}
    setRequestHeader() {}
    send() { this.loaded(); }
  };
  try {
    await act(async () => view.container.querySelector('[data-testid="scope-all-files"]').click());
    assert.match(view.container.textContent, /Uploads and new folders are saved to Root/);
    await clickText(view.container, "New Folder");
    assert.match(document.querySelector('[role="dialog"]').textContent, /Parent Folder: Root/);
    await inputText(document.querySelector("#folder-name"), "New at Root");
    await clickText(document.querySelector('[role="dialog"]'), "Create Folder");
    await waitFor(() => createdFolders.length === 1);
    assert.equal(createdFolders[0].parent_folder_id, null);
    const upload = view.container.querySelector('[data-testid="input-file-upload"]');
    Object.defineProperty(upload, "files", { configurable: true, value: [new window.File(["pdf"], "new.pdf", { type: "application/pdf" })] });
    await act(async () => upload.dispatchEvent(new window.Event("change", { bubbles: true })));
    await waitFor(() => createdFiles.length === 1);
    assert.equal(createdFiles[0].folder_id, null);
    await clickText(view.container, "Bulk Move Mode");
    await clickText(view.container, "Select All");
    await clickText(view.container, "Move 4 Selected");
    const dialog = document.querySelector('[role="dialog"]');
    assert.doesNotMatch(dialog.textContent, /All files/);
    await clickText(dialog, "Beta");
    await waitFor(() => moves.length === 4);
    assert.deepEqual(moves.map(([id, data]) => [id, data.folder_id]), scopeFiles.map(f => [f.id, "b"]));
  } finally {
    globalThis.fetch = fetchBefore;
    globalThis.XMLHttpRequest = xhrBefore;
    await view.cleanup();
  }
});