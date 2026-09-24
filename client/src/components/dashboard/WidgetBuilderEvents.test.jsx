import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.DocumentFragment = dom.window.DocumentFragment;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { default: WidgetBuilderModal } = await import("./WidgetBuilderModal.jsx");

const eventSource = {
  id: "event",
  label: "Events",
  isEvent: true,
  systemFields: [
    { name: "id", label: "ID", type: "id" },
    { name: "event_kind", label: "Event kind", type: "enum", options: [] },
    { name: "status", label: "Status", type: "enum", options: [] },
    { name: "event_start_date", label: "Event start date", type: "date" },
  ],
  customFields: [],
};

async function mount(config) {
  const originalFetch = globalThis.fetch;
  const previews = [];
  globalThis.fetch = async (url, options) => {
    if (url === "/api/dashboard/widgets/preview") {
      previews.push(JSON.parse(options.body));
    }
    return { ok: true, json: async () => ({ data: { type: "scalar", value: 2 } }) };
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  client.setQueryData(["/api/dashboard/sources"], { sources: [eventSource] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <WidgetBuilderModal
        open
        initialWidget={{
          title: "Events",
          widget_type: "stat",
          scope: "personal",
          config,
        }}
        onClose={() => {}}
        onSave={() => {}}
        canSavePersonal
      />
    </QueryClientProvider>,
  ));
  await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
  return {
    previews,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
      globalThis.fetch = originalFetch;
    },
  };
}

test("Events builder explains counting rules and previews a Count config", async () => {
  const view = await mount({
    source: "event",
    measure: { aggregator: "count", field: null, fieldKind: null, fieldId: null },
    filters: [],
  });
  try {
    const semantics = document.querySelector('[data-testid="event-counting-semantics"]');
    assert.match(semantics.textContent, /simple and complex events once each/i);
    assert.match(semantics.textContent, /period in which they start/i);
    assert.match(semantics.textContent, /whole selected day/i);
    assert.equal(document.querySelector('[data-testid="button-save-widget"]').disabled, false);
    assert.equal(view.previews.at(-1).config.measure.aggregator, "count");
  } finally {
    await view.cleanup();
  }
});

test("Events builder blocks an incompatible saved aggregation", async () => {
  const view = await mount({
    source: "event",
    measure: { aggregator: "sum", field: "id", fieldKind: "system", fieldId: null },
    filters: [],
  });
  try {
    assert.match(
      document.querySelector('[data-testid="widget-validation-errors"]').textContent,
      /only support Count with no measure field/,
    );
    assert.equal(document.querySelector('[data-testid="button-save-widget"]').disabled, true);
  } finally {
    await view.cleanup();
  }
});