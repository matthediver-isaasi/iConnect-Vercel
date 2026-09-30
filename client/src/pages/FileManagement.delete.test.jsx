import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.test/admin/files",
});
for (const key of [
  "window", "document", "navigator", "HTMLElement", "Element", "Node",
  "DocumentFragment", "HTMLInputElement", "MutationObserver", "CustomEvent", "Event",
  "MouseEvent", "localStorage",
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
  ["FileRepositoryFolder", "list"],
  ["FileRepositoryFolder", "delete"],
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
  base44.entities.FileRepository.list = async () => {
    fileListCalls += 1;
    return structuredClone(currentFiles);
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