import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "http://localhost/sales/settings" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
after(() => dom.window.close());

// Only discovery is stubbed. All three mounted cards share a real QueryClient,
// just as useSalesSettings does, including refetches and version publication.
const compiled = await build({
  stdin: {
    contents: 'export { default as Naming } from "./QuoteNamingSettings.jsx"; export { default as Tasks } from "./QuoteTaskSettings.jsx"; export { default as Catalogue } from "./CatalogueVisibilitySettings.jsx";',
    resolveDir: `${process.cwd()}/client/src/components/sales`, loader: "jsx",
  },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{
    name: "scoped-settings-fixture",
    setup(build) {
      build.onResolve({ filter: /^\.\/useSalesSettings$/ }, () => ({ path: "settings-hook", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        import { useQuery, useQueryClient } from "@tanstack/react-query";
        export const salesSettingsRequest = (...args) => globalThis.settingsFixture.request(...args);
        export function useSalesSettings(request = salesSettingsRequest) {
          const fixture = globalThis.settingsFixture;
          const key = ["sales-settings", fixture.scope];
          const qc = useQueryClient();
          const query = useQuery({ queryKey: key, queryFn: () => fixture.load(), retry: false, staleTime: Infinity });
          const accept = async result => {
            await qc.cancelQueries({ queryKey: key, exact: true });
            qc.setQueryData(key, old => !old || result.version >= old.version ? result : old);
          };
          return { ...query, data: query.isError ? undefined : query.data,
            lastConfirmedData: query.data, ready: query.isSuccess, scopeKey: JSON.stringify(key),
            patch: patch => {
              if (fixture.scope !== key[1]) throw new Error("Your tenant or session changed.");
              return request("/api/sales/settings", { method: "PATCH", body: JSON.stringify(patch) });
            },
            accept, publish: accept };
        }`, loader: "js", resolveDir: process.cwd() }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/settings-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/settings-test.cjs`);
const { Naming, Tasks, Catalogue } = mod.exports;
const initial = () => ({ version: 1, quoteTaskListName: "Quote tasks", quoteSingularName: "Quote", quotePluralName: "Quotes", quoteUrlSegment: "quotes", showInternalCode: true, showSku: true });
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

async function mounted(callback, { canManage = true, failLoad = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  let server = initial();
  let conflict = false;
  const calls = [];
  const fixture = {
    scope: "tenant-one/member-one",
    load: async () => {
      if (failLoad) throw new Error("Settings unavailable");
      return { ...server };
    },
    request: async (url, options) => {
      assert.equal(url, "/api/sales/settings");
      assert.equal(options.method, "PATCH");
      const body = JSON.parse(options.body);
      calls.push(body);
      if (conflict) {
        conflict = false;
        server = { ...server, version: server.version + 1 };
        throw Object.assign(new Error("Version conflict"), { status: 409 });
      }
      assert.equal(body.expectedVersion, server.version);
      const { expectedVersion, ...patch } = body;
      server = { ...server, ...patch, version: expectedVersion + 1 };
      return { ...server };
    },
  };
  globalThis.settingsFixture = fixture;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async (allowed = canManage) => {
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client },
        React.createElement(React.Fragment, null,
          React.createElement(Naming, { canManage: allowed, request: fixture.request }),
          React.createElement(Tasks, { canManage: allowed, request: fixture.request }),
          React.createElement(Catalogue, { canManage: allowed, request: fixture.request }))));
      await settle();
    });
    await act(settle);
  };
  const input = id => host.querySelector(`#${id}`);
  const change = async (id, value) => act(async () => {
    const element = input(id);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const submit = async index => {
    await act(async () => {
      host.querySelectorAll("form")[index].dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    await act(settle);
  };
  try {
    await render();
    await callback({
      host, input, change, submit, calls, fixture, render,
      conflict: () => { conflict = true; },
      allowLoad: () => { failLoad = false; },
      failLoad: () => { failLoad = true; },
      refresh: async () => {
        await act(async () => { await client.refetchQueries({ queryKey: ["sales-settings", fixture.scope] }); await settle(); });
        await act(settle);
      },
      publish: async patch => {
        server = { ...server, ...patch };
        await act(async () => { client.setQueryData(["sales-settings", fixture.scope], { ...server }); await settle(); });
      },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove(); client.clear(); delete globalThis.settingsFixture;
  }
}

test("naming suggests a segment, previews full path, preserves manual overrides and saves trimmed labels", async () => {
  await mounted(async ({ host, input, change, submit, calls }) => {
    await change("quote-singular-name", " Proposal ");
    await change("quote-plural-name", " Proposals ");
    assert.equal(input("quote-url-segment").value, "proposals");
    assert.match(host.querySelector("#quote-url-preview").textContent, /\/sales\/proposals/);
    await change("quote-url-segment", "commercial-offers");
    await change("quote-plural-name", " Commercial offers ");
    assert.equal(input("quote-url-segment").value, "commercial-offers");
    await submit(0);
    assert.deepEqual(calls, [{ expectedVersion: 1, quoteSingularName: "Proposal", quotePluralName: "Commercial offers", quoteUrlSegment: "commercial-offers" }]);
    assert.equal(input("quote-singular-name").value, "Proposal");
    assert.equal(input("quote-task-list-name").value, "Quote tasks");
    assert.match(host.textContent, /Naming settings saved/);
    assert.match(host.textContent, /Module naming/);
    assert.match(host.textContent, /when the proposal was issued/);
    assert.match(host.textContent, /permanent compatibility path \/sales\/quotes/);
    assert.match(host.textContent, /Previous custom URL aliases are not retained/);
  });
});

test("validation rejects reserved or malformed segments and blank labels without requests", async () => {
  await mounted(async ({ host, change, submit, calls }) => {
    for (const slug of ["settings", "BAD", "-offers", "two--hyphens", ""]) {
      await change("quote-url-segment", slug);
      await submit(0);
      assert.equal(calls.length, 0);
      assert.ok(host.querySelector('[role="alert"]'));
    }
    await change("quote-url-segment", "offers");
    await change("quote-singular-name", "   ");
    await submit(0);
    assert.equal(calls.length, 0);
    assert.match(host.textContent, /Singular name must contain/);
  });
});

test("both cards use the newest version without remounting or erasing unrelated dirty inputs", async () => {
  await mounted(async ({ input, change, submit, calls, host }) => {
    const taskInput = input("quote-task-list-name");
    const namingInput = input("quote-singular-name");
    await change("quote-task-list-name", " Delivery ");
    await change("quote-singular-name", "Proposal");
    await change("quote-plural-name", "Proposals");
    await submit(0);
    assert.equal(input("quote-task-list-name"), taskInput);
    assert.equal(taskInput.value, " Delivery ");
    await change("quote-singular-name", "Estimate");
    await submit(1);
    assert.equal(calls[1].expectedVersion, 2);
    assert.equal(calls[1].quoteTaskListName, "Delivery");
    assert.equal(input("quote-singular-name"), namingInput);
    assert.equal(namingInput.value, "Estimate");
    assert.match(host.textContent, /Task settings saved/);
    await submit(0);
    assert.equal(calls[2].expectedVersion, 3);
  });
});

test("all three settings forms share versions and preserve unrelated dirty naming, task and visibility fields", async () => {
  await mounted(async ({ host, input, change, submit, calls }) => {
    const namingInput = input("quote-singular-name");
    const taskInput = input("quote-task-list-name");
    const visibilityInput = host.querySelector('input[type="checkbox"]');
    await change("quote-singular-name", "Proposal");
    await change("quote-task-list-name", "Delivery");
    await act(async () => visibilityInput.click());
    assert.equal(visibilityInput.checked, false);
    await submit(0);
    assert.equal(input("quote-task-list-name"), taskInput);
    assert.equal(taskInput.value, "Delivery");
    assert.equal(visibilityInput.checked, false);
    await change("quote-singular-name", "Estimate");
    await submit(2);
    assert.deepEqual(calls[1], { showInternalCode: false, expectedVersion: 2 });
    assert.equal(input("quote-singular-name"), namingInput);
    assert.equal(namingInput.value, "Estimate");
    assert.equal(taskInput.value, "Delivery");
    assert.equal(host.querySelector('input[type="checkbox"]'), visibilityInput);
    await submit(1);
    assert.equal(calls[2].expectedVersion, 3);
    assert.equal(namingInput.value, "Estimate");
    await submit(0);
    assert.equal(calls[3].expectedVersion, 4);
    assert.match(host.textContent, /Catalogue visibility saved/);
  });
});

test("refresh errors retain all three drafts with lastConfirmedData and block writes until recovery", async () => {
  await mounted(async ({ host, input, change, submit, calls, failLoad, allowLoad, refresh }) => {
    await change("quote-singular-name", "Proposal");
    await change("quote-task-list-name", "Private delivery");
    const namingInput = input("quote-singular-name");
    const taskInput = input("quote-task-list-name");
    const visibilityInput = host.querySelector('input[type="checkbox"]');
    await act(async () => visibilityInput.click());
    failLoad();
    await refresh();
    assert.equal(input("quote-singular-name"), namingInput);
    assert.equal(input("quote-task-list-name"), taskInput);
    assert.equal(namingInput.value, "Proposal");
    assert.equal(taskInput.value, "Private delivery");
    assert.equal(visibilityInput.checked, false);
    assert.ok([...host.querySelectorAll("input")].every(element => element.disabled));
    await submit(0); await submit(1); await submit(2);
    assert.equal(calls.length, 0);
    allowLoad();
    await refresh();
    assert.equal(namingInput.value, "Proposal");
    assert.equal(taskInput.value, "Private delivery");
    assert.equal(visibilityInput.checked, false);
    await submit(2);
    assert.equal(calls[0].expectedVersion, 1);
    await submit(0);
    assert.equal(calls[1].expectedVersion, 2);
    await submit(1);
    assert.equal(calls[2].expectedVersion, 3);
  });
});

for (const [index, id, value] of [[0, "quote-singular-name", "Proposal"], [1, "quote-task-list-name", "Delivery"]]) {
  test(`card ${index} preserves edits after 409 and retries using refetched version`, async () => {
    await mounted(async ({ host, input, change, submit, calls, conflict }) => {
      await change(id, value);
      const node = input(id);
      conflict();
      await submit(index);
      assert.equal(input(id), node);
      assert.equal(input(id).value, value);
      assert.match(host.textContent, /preserved/);
      assert.match(host.textContent, /Retry saving/);
      await submit(index);
      assert.equal(calls[1].expectedVersion, 2);
      assert.equal(input(id).value, value);
    });
  });
}

test("pristine fields reconcile shared updates; changing scope clears every dirty draft", async () => {
  await mounted(async ({ input, change, publish, fixture, render }) => {
    await change("quote-singular-name", "Local proposal");
    await publish({ version: 2, quoteSingularName: "Estimate", quotePluralName: "Estimates", quoteUrlSegment: "estimates", quoteTaskListName: "Fulfilment" });
    assert.equal(input("quote-singular-name").value, "Local proposal");
    assert.equal(input("quote-plural-name").value, "Estimates");
    assert.equal(input("quote-task-list-name").value, "Fulfilment");
    await change("quote-task-list-name", "Private draft");
    fixture.scope = "tenant-two/member-two";
    fixture.load = async () => ({ ...initial(), quoteTaskListName: "Tenant two tasks" });
    await render();
    assert.equal(input("quote-singular-name").value, "Quote");
    assert.equal(input("quote-task-list-name").value, "Tenant two tasks");
  });
});

test("read-only permission blocks even directly dispatched form submissions", async () => {
  await mounted(async ({ host, submit, calls }) => {
    assert.ok([...host.querySelectorAll("input")].every(input => input.disabled));
    await submit(0); await submit(1);
    assert.equal(calls.length, 0);
    assert.equal(host.querySelector('button[type="submit"]'), null);
  }, { canManage: false });
});

test("revoking manage permission blocks dirty forms without losing their draft values", async () => {
  await mounted(async ({ input, change, render, submit, calls }) => {
    await change("quote-singular-name", "Proposal");
    await change("quote-task-list-name", "Delivery");
    await render(false);
    await submit(0); await submit(1);
    assert.equal(calls.length, 0);
    assert.equal(input("quote-singular-name").value, "Proposal");
    assert.equal(input("quote-task-list-name").value, "Delivery");
  });
});

test("manual URL suggestions can be restored and continue following the plural name", async () => {
  await mounted(async ({ host, input, change }) => {
    await change("quote-url-segment", "custom-offers");
    await change("quote-plural-name", "Estimates");
    assert.equal(input("quote-url-segment").value, "custom-offers");
    const suggest = [...host.querySelectorAll("button")].find(button => button.textContent === "Use suggested URL segment");
    await act(async () => suggest.click());
    assert.equal(input("quote-url-segment").value, "estimates");
    await change("quote-plural-name", "Commercial offers");
    assert.equal(input("quote-url-segment").value, "commercial-offers");
  });
});

test("settings discovery errors expose retry and recover both mounted cards", async () => {
  await mounted(async ({ host, allowLoad, input }) => {
    assert.match(host.textContent, /Settings unavailable/);
    allowLoad();
    await act(async () => { host.querySelector("button").click(); await settle(); });
    await act(settle);
    assert.equal(input("quote-singular-name").value, "Quote");
    assert.equal(input("quote-task-list-name").value, "Quote tasks");
  }, { failLoad: true });
});
