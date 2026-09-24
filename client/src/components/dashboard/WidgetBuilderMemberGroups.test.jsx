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

const source = {
  id: "member_group",
  label: "Member Groups",
  systemFields: [
    { name: "group_id", label: "Group", type: "reference" },
    { name: "organization_id", label: "Organisation", type: "reference" },
    { name: "group_role", label: "Role", type: "enum", options: [] },
    { name: "membership_at", label: "Membership history date", type: "date" },
  ],
  customFields: [],
};

const initialWidget = {
  title: "Current organisations",
  widget_type: "stat",
  scope: "personal",
  config: {
    source: "member_group",
    measure: {
      aggregator: "count",
      fieldKind: "system",
      field: "current_organizations",
      fieldId: null,
    },
    groupBy: null,
    seriesBy: null,
    filters: [{
      fieldKind: "system",
      field: "group_id",
      fieldId: null,
      operator: "in",
      value: ["group-a", "group-b"],
    }],
    timeBucket: null,
    cumulative: false,
    clickThrough: false,
  },
};

async function settle(ms = 400) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

async function renderBuilder(widget, onSave) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  client.setQueryData(["/api/dashboard/sources"], { sources: [source] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <WidgetBuilderModal
        open
        initialWidget={widget}
        onClose={() => {}}
        onSave={onSave}
        canSavePersonal
      />
    </QueryClientProvider>,
  ));
  await settle();
  return async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  };
}

function reportingConfig(config) {
  return {
    source: config.source,
    measure: config.measure,
    groupBy: config.groupBy,
    seriesBy: config.seriesBy,
    filters: config.filters,
    timeBucket: config.timeBucket,
    cumulative: config.cumulative,
    clickThrough: config.clickThrough,
  };
}

test("Current distinct organisations previews zero, saves, and reopens without temporal or click-through controls", async () => {
  const originalFetch = globalThis.fetch;
  const previewConfigs = [];
  globalThis.fetch = async (url, options) => {
    if (url === "/api/dashboard/widgets/preview") {
      previewConfigs.push(JSON.parse(options.body).config);
    }
    return {
      ok: true,
      json: async () => ({ data: { type: "scalar", value: 0, total: 0 } }),
    };
  };

  let saved;
  let cleanup;
  try {
    cleanup = await renderBuilder(initialWidget, value => { saved = value; });
    assert.match(document.querySelector('[data-testid="widget-preview-pane"]').textContent, /^0/);
    const measurePicker = document.querySelector('[data-testid="select-widget-field"]');
    assert.ok(measurePicker);
    assert.equal(measurePicker.textContent.trim(), "Current distinct organisations");
    assert.ok(document.querySelector('[data-testid="select-widget-groupby"]'));
    assert.equal(document.querySelector('[data-testid="select-widget-timebucket-field"]'), null);
    assert.equal(document.querySelector('[data-testid="switch-widget-cumulative"]'), null);
    assert.equal(document.querySelector('[data-testid="switch-widget-click-through"]'), null);
    const previewBeforeSave = previewConfigs.at(-1);
    assert.deepEqual(previewBeforeSave.measure, initialWidget.config.measure);
    assert.equal(previewBeforeSave.timeBucket, null);
    assert.equal(previewBeforeSave.cumulative, false);
    assert.deepEqual(previewBeforeSave.filters, initialWidget.config.filters);
    assert.equal(Object.hasOwn(previewBeforeSave, "clickThrough"), false);

    const save = document.querySelector('[data-testid="button-save-widget"]');
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.deepEqual(reportingConfig(saved.config), reportingConfig(previewBeforeSave));
    await cleanup();
    cleanup = null;

    cleanup = await renderBuilder(saved, () => {});
    assert.match(document.querySelector('[data-testid="widget-preview-pane"]').textContent, /^0/);
    assert.equal(
      document.querySelector('[data-testid="select-widget-field"]').textContent.trim(),
      "Current distinct organisations",
    );
    assert.ok(document.querySelector('[data-testid="select-widget-groupby"]'));
    assert.equal(document.querySelector('[data-testid="select-widget-timebucket-field"]'), null);
    assert.equal(document.querySelector('[data-testid="switch-widget-click-through"]'), null);
    assert.deepEqual(reportingConfig(previewConfigs.at(-1)), reportingConfig(saved.config));
    assert.deepEqual(saved.config.filters, initialWidget.config.filters);
  } finally {
    if (cleanup) await cleanup();
    globalThis.fetch = originalFetch;
  }
});