import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/organisations/org-1",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { LayoutProvider, useLayoutContext } = await import("../../contexts/LayoutContext.jsx");
const {
  RelatedRecordsDefinitionState,
  RelatedRecordsPanel,
  useRelatedRecordDefinitions,
} = await import("./RelatedRecordsPanel.jsx");

function Identity({ children }) {
  const layout = useLayoutContext();
  useEffect(() => {
    layout.setMemberInfo({ id: "viewer-1", tenant_id: "tenant-1" });
    layout.setSessionValidated(true);
    layout.setAuthResolved(true);
  }, []);
  return children;
}

const customContext = {
  kind: "custom_object",
  objectId: "object-1",
  recordId: "record-1",
};
const coreContext = {
  kind: "organization",
  recordId: "org-1",
};

const definitionFor = (context = coreContext) => ({
  id: "definition-1",
  status: "active",
  cardinality: "many_to_many",
  source_kind: context.kind,
  source_custom_object_id: context.objectId,
  target_kind: "member",
  source_label: context.kind === "organization" ? "Members" : "People",
  target_label: "Organisations",
  show_on_source: true,
  edit_from_source: false,
  can_edit: false,
});

const edge = (label, id = label.toLowerCase().replace(/\W+/g, "-")) => ({
  relationship_id: `edge-${id}`,
  related_kind: "member",
  related_record_id: id,
  related: { id, kind: "member", primary_label: label },
});

const rows = (items, extra = {}) => ({
  data: items,
  total: items.length,
  pageSize: 10,
  ...extra,
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(delay = 15) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, delay));
  });
}

async function mount(child, clientOptions = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        ...clientOptions,
      },
    },
  });
  const render = async next => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <LayoutProvider><Identity>{next}</Identity></LayoutProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };
  await render(child);
  return {
    container,
    client,
    render,
    async cleanup() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

const loadingSurface = container =>
  container.querySelector('[data-testid="related-records-loading"]');

function assertLoadingSemantics(container) {
  const overlay = loadingSurface(container);
  assert.ok(overlay, "loading overlay should be visible");
  const content = container.querySelector("[data-related-records-content]");
  assert.equal(content.getAttribute("aria-busy"), "true");
  assert.equal(content.getAttribute("aria-hidden"), "true");
  assert.ok(content.hasAttribute("inert"));
  const status = overlay.querySelector('[role="status"]');
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.getAttribute("aria-atomic"), "true");
  assert.match(status.textContent, /Loading records/);
  assert.ok(!content.contains(status), "live status must sit outside inert content");
}

function DefinitionsFlow({ context, displayMode = "columns" }) {
  const query = useRelatedRecordDefinitions({ context });
  if (query.data == null) return <RelatedRecordsDefinitionState query={query} />;
  if (!query.panels.length) return <div data-testid="no-panels" />;
  const panel = query.panels[0];
  return (
    <RelatedRecordsPanel
      context={query.context}
      record={{ id: context.recordId, capabilities: { edit_records: false } }}
      definition={panel.definition}
      side={panel.side}
      displayMode={displayMode}
      loadingOverlay
    />
  );
}

test("keeps one accessible loading surface through delayed definitions and rows", async () => {
  const definitions = deferred();
  const records = deferred();
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("relationship-definitions")) return definitions.promise;
    if (path.includes("/relationships?")) return records.promise;
    throw new Error(`Unexpected request: ${path}`);
  };

  const view = await mount(<DefinitionsFlow context={customContext} />);
  assertLoadingSemantics(view.container);
  definitions.resolve(json({
    data: [{ definition: definitionFor(customContext), side: "source" }],
    total: 1,
  }));
  await settle();
  assertLoadingSemantics(view.container);
  assert.doesNotMatch(view.container.textContent, /Delayed person/);

  records.resolve(json(rows([edge("Delayed person")])));
  await settle();
  assert.equal(loadingSurface(view.container), null);
  assert.match(view.container.textContent, /Delayed person/);
  const content = view.container.querySelector("[data-related-records-content]");
  assert.equal(content.hasAttribute("inert"), false);
  assert.equal(content.hasAttribute("aria-hidden"), false);
  assert.equal(content.hasAttribute("aria-busy"), false);
  await view.cleanup();
});

test("definition failure exposes an alert and retries through the actual hook", async () => {
  let definitionCalls = 0;
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes("relationship-definitions")) {
      definitionCalls += 1;
      return definitionCalls === 1
        ? json({ error: "temporary failure" }, 503)
        : json({ data: [], total: 0 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const view = await mount(<DefinitionsFlow context={customContext} />);
  const alert = view.container.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /Records could not be loaded/);
  assert.equal(loadingSurface(view.container), null);
  const retry = [...view.container.querySelectorAll("button")]
    .find(button => button.textContent.includes("Retry"));
  await act(async () => retry.click());
  await settle();
  assert.equal(definitionCalls, 2);
  assert.ok(view.container.querySelector('[data-testid="no-panels"]'));
  await view.cleanup();
});

test("row failure leaves the overlay, announces the error, and retries successfully", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? json({ error: "Rows temporarily unavailable" }, 503)
      : json(rows([edge("Recovered row")]));
  };
  const view = await mount(
    <RelatedRecordsPanel
      context={coreContext}
      record={{ id: "org-1" }}
      definition={definitionFor(coreContext)}
      side="source"
      loadingOverlay
    />,
  );
  assert.equal(loadingSurface(view.container), null);
  const alert = view.container.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /Rows temporarily unavailable/);
  const retry = [...alert.querySelectorAll("button")]
    .find(button => button.textContent.includes("Retry"));
  await act(async () => retry.click());
  await settle();
  assert.equal(calls, 2);
  assert.match(view.container.textContent, /Recovered row/);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  await view.cleanup();
});

test("renders populated and empty results in columns and cards modes", async () => {
  for (const [displayMode, result, expected] of [
    ["columns", rows([edge("Column person")]), /Column person/],
    ["cards", rows([edge("Card person")]), /Card person/],
    ["columns", rows([]), /No members linked yet/],
    ["cards", rows([]), /No members linked yet/],
  ]) {
    globalThis.fetch = async url => {
      assert.match(String(url), /core\/relationships/);
      return json(result);
    };
    const view = await mount(
      <RelatedRecordsPanel
        context={coreContext}
        record={{ id: "org-1" }}
        definition={definitionFor(coreContext)}
        side="source"
        displayMode={displayMode}
        loadingOverlay
      />,
    );
    assert.match(view.container.textContent, expected);
    assert.equal(loadingSurface(view.container), null);
    if (result.data.length)
      assert.equal(view.container.querySelector(displayMode === "cards" ? "article" : "tbody tr") !== null, true);
    await view.cleanup();
  }
});

test("page and sort refetches retain rows only beneath an inert loading overlay", async () => {
  const requests = [];
  const pageTwo = deferred();
  const sorted = deferred();
  globalThis.fetch = async url => {
    const path = String(url);
    requests.push(path);
    const params = new URL(path, "https://tenant.example.test").searchParams;
    if (params.get("sortField")) return sorted.promise;
    if (params.get("page") === "2") return pageTwo.promise;
    return json(rows([edge("First page")], { total: 11 }));
  };

  const view = await mount(
    <RelatedRecordsPanel
      context={coreContext}
      record={{ id: "org-1" }}
      definition={definitionFor(coreContext)}
      side="source"
      loadingOverlay
    />,
  );
  assert.match(view.container.textContent, /First page/);
  const pageStatus = [...view.container.querySelectorAll("span")]
    .find(span => span.textContent.trim() === "Page 1 of 2");
  assert.ok(pageStatus, view.container.textContent);
  const paginationButtons = [...pageStatus.parentElement.querySelectorAll("button")];
  await act(async () => paginationButtons.at(-1).click());
  await settle();
  assert.match(requests.at(-1), /page=2/);
  assert.match(view.container.textContent, /First page/);
  assertLoadingSemantics(view.container);

  pageTwo.resolve(json(rows([edge("Second page")], { total: 11 })));
  await settle();
  assert.match(view.container.textContent, /Second page/);
  assert.equal(loadingSurface(view.container), null);

  const sort = view.container.querySelector("thead button");
  assert.ok(sort);
  await act(async () => sort.click());
  await settle();
  assert.match(requests.at(-1), /sortField=record/);
  assert.match(view.container.textContent, /Second page/);
  assertLoadingSemantics(view.container);
  sorted.resolve(json(rows([edge("Sorted person")], { total: 1 })));
  await settle();
  assert.match(view.container.textContent, /Sorted person/);
  assert.equal(loadingSurface(view.container), null);
  await view.cleanup();
});

test("switching record identity never displays rows from the previous identity", async () => {
  const secondIdentity = deferred();
  globalThis.fetch = async url => {
    const path = String(url);
    const params = new URL(path, "https://tenant.example.test").searchParams;
    return params.get("recordId") === "org-2"
      ? secondIdentity.promise
      : json(rows([edge("Old identity row")]));
  };
  const panel = recordId => (
    <RelatedRecordsPanel
      context={{ kind: "organization", recordId }}
      record={{ id: recordId }}
      definition={definitionFor(coreContext)}
      side="source"
      loadingOverlay
    />
  );
  const view = await mount(panel("org-1"));
  assert.match(view.container.textContent, /Old identity row/);
  await view.render(panel("org-2"));
  assertLoadingSemantics(view.container);
  assert.doesNotMatch(view.container.textContent, /Old identity row/);

  secondIdentity.resolve(json(rows([edge("New identity row")])));
  await settle();
  assert.match(view.container.textContent, /New identity row/);
  assert.doesNotMatch(view.container.textContent, /Old identity row/);
  await view.cleanup();
});

test("custom-object and core contexts use their respective relationship routes", async () => {
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return json(rows([edge("Route person")]));
  };
  for (const context of [customContext, coreContext]) {
    const view = await mount(
      <RelatedRecordsPanel
        context={context}
        record={{ id: context.recordId, capabilities: { edit_records: false } }}
        definition={definitionFor(context)}
        side="source"
        loadingOverlay
      />,
    );
    assert.match(view.container.textContent, /Route person/);
    await view.cleanup();
  }
  assert.ok(requests.some(path => path.startsWith("/api/custom-objects/object-1/relationships?")));
  assert.ok(requests.some(path => path.startsWith("/api/custom-objects/core/relationships?")));
});

test("standalone opt-out keeps the legacy skeleton without overlay or inert semantics", async () => {
  const records = deferred();
  globalThis.fetch = async () => records.promise;
  const view = await mount(
    <RelatedRecordsPanel
      context={coreContext}
      record={{ id: "org-1" }}
      definition={definitionFor(coreContext)}
      side="source"
    />,
  );
  assert.equal(loadingSurface(view.container), null);
  assert.equal(view.container.querySelector("[data-related-records-surface]"), null);
  assert.ok(view.container.querySelector('[aria-hidden="true"]'));
  records.resolve(json(rows([])));
  await settle();
  assert.match(view.container.textContent, /No members linked yet/);
  await view.cleanup();
});