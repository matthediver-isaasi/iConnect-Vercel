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

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;

const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { default: WidgetBuilderModal } = await import("./WidgetBuilderModal.jsx");

async function settle(ms = 0) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

async function mountBuilder({ source, widget, onSave, fetchImpl }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  client.setQueryData(["/api/dashboard/sources"], { sources: [source] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = async initialWidget => {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <WidgetBuilderModal
          open
          initialWidget={initialWidget}
          onClose={() => {}}
          onSave={onSave}
          canSavePersonal
        />
      </QueryClientProvider>,
    ));
    await settle();
  };
  await render(widget);

  return {
    render,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
      globalThis.fetch = originalFetch;
    },
  };
}

function widgetWithFilter(source, filter) {
  return {
    title: "Date comparison",
    widget_type: "stat",
    scope: "personal",
    config: {
      source,
      measure: { aggregator: "count", field: null, fieldKind: null, fieldId: null },
      filters: [filter],
    },
  };
}

test("mounted builder preserves a legacy system date, normalizes preview/save, and reopens ISO", async () => {
  const previewBodies = [];
  let saved;
  const source = {
    id: "organization",
    label: "Organisations",
    systemFields: [{ name: "created_at", label: "Created at", type: "date" }],
    customFields: [],
  };
  const initial = widgetWithFilter("organization", {
    fieldKind: "system",
    field: "created_at",
    fieldId: null,
    operator: "gte",
    value: "05/02/2025",
  });
  const view = await mountBuilder({
    source,
    widget: initial,
    onSave: value => { saved = value; },
    fetchImpl: async (url, options) => {
      if (url === "/api/dashboard/widgets/preview") {
        previewBodies.push(JSON.parse(options.body));
      }
      return { ok: true, json: async () => ({ data: { type: "scalar", value: 1 } }) };
    },
  });

  try {
    const input = document.querySelector('[data-testid="input-filter-value-0"]');
    assert.equal(input.value, "05/02/2025");
    assert.match(
      document.querySelector('[data-testid="text-filter-date-help-0"]').textContent,
      /DD\/MM\/YYYY or YYYY-MM-DD/,
    );

    await settle(400);
    assert.ok(previewBodies.length > 0);
    assert.equal(previewBodies.at(-1).config.filters[0].value, "2025-02-05");

    const save = document.querySelector('[data-testid="button-save-widget"]');
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.equal(saved.config.filters[0].value, "2025-02-05");

    await view.render(saved);
    assert.equal(
      document.querySelector('[data-testid="input-filter-value-0"]').value,
      "2025-02-05",
    );
  } finally {
    await view.cleanup();
  }
});

test("mounted builder identifies organisation custom dates and preserves invalid partial input", async () => {
  const previewBodies = [];
  let saved;
  const sharedId = "shared-field-id";
  const source = {
    id: "event_booking",
    label: "Event Bookings",
    isBooking: true,
    systemFields: [],
    // Deliberately reuse the id to prove orgField selects the organisation
    // descriptor rather than this non-date booking descriptor.
    customFields: [{ id: sharedId, label: "Booking note", type: "text" }],
    organisationFields: [{ id: sharedId, label: "Renewal date", type: "date" }],
  };
  const initial = widgetWithFilter("event_booking", {
    fieldKind: "custom",
    field: null,
    fieldId: sharedId,
    orgField: true,
    operator: "lt",
    value: "31/02/2025",
  });
  const view = await mountBuilder({
    source,
    widget: initial,
    onSave: value => { saved = value; },
    fetchImpl: async (url, options) => {
      if (url === "/api/dashboard/widgets/preview") {
        previewBodies.push(JSON.parse(options.body));
      }
      return { ok: true, json: async () => ({ data: { type: "scalar", value: 1 } }) };
    },
  });

  try {
    let input = document.querySelector('[data-testid="input-filter-value-0"]');
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.match(
      document.querySelector('[data-testid="text-filter-date-help-0"]').textContent,
      /valid calendar date/i,
    );
    assert.match(
      document.querySelector('[data-testid="widget-validation-errors"]').textContent,
      /Filter 1: Enter a valid calendar date/i,
    );
    assert.equal(document.querySelector('[data-testid="button-save-widget"]').disabled, true);

    await settle(400);
    assert.equal(previewBodies.length, 0);
    assert.match(
      document.querySelector('[data-testid="widget-preview-pane"]').textContent,
      /Filter 1: Enter a valid calendar date/i,
    );

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "31/");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    input = document.querySelector('[data-testid="input-filter-value-0"]');
    assert.equal(input.value, "31/");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(document.querySelector('[data-testid="button-save-widget"]').disabled, true);
    assert.equal(saved, undefined);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "06/03/2025");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await settle(400);
    assert.equal(previewBodies.at(-1).config.filters[0].value, "2025-03-06");
    const save = document.querySelector('[data-testid="button-save-widget"]');
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.equal(saved.config.filters[0].value, "2025-03-06");
    assert.equal(saved.config.filters[0].orgField, true);
  } finally {
    await view.cleanup();
  }
});