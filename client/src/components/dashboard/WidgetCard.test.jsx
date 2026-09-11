import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

class TestResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }

  observe(element) {
    this.element = element;
  }

  unobserve() {}

  disconnect() {}

  static flush(contentRect) {
    for (const observer of TestResizeObserver.instances) {
      if (observer.element) {
        observer.callback([{ target: observer.element, contentRect }]);
      }
    }
  }
}

globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;

const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const {
  buildExportRows,
  default: WidgetCard,
  widgetDataQueryKey,
  widgetRequestUrl,
} = await import("./WidgetCard.jsx");
const { dashboardWidgetChartColours, normalizeDashboardWidgetPalette } =
  await import("@shared/dashboardWidgetPalette.js");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");

test("Canvas requests opt into the embed presentation without changing dashboard URLs", () => {
  assert.equal(
    widgetRequestUrl("/api/dashboard/widgets/widget-1/data"),
    "/api/dashboard/widgets/widget-1/data",
  );
  assert.equal(
    widgetRequestUrl("/api/dashboard/widgets/widget-1/data", true),
    "/api/dashboard/widgets/widget-1/data?embed=canvas",
  );
  assert.equal(
    widgetRequestUrl("/api/dashboard/widgets/widget-1/drilldown?existing=1", true),
    "/api/dashboard/widgets/widget-1/drilldown?existing=1&embed=canvas",
  );
});

test("Canvas data has an isolated, instance-scoped React Query identity", () => {
  const dashboardKey = widgetDataQueryKey("widget-1");
  const canvasKey = widgetDataQueryKey("widget-1", true, "canvas-instance-a");
  const secondCanvasKey = widgetDataQueryKey("widget-1", true, "canvas-instance-b");

  assert.notDeepEqual(canvasKey, dashboardKey);
  assert.notDeepEqual(canvasKey, secondCanvasKey);
  assert.deepEqual(canvasKey, [
    "/api/dashboard/widgets",
    "widget-1",
    "data",
    "canvas",
    "canvas-instance-a",
  ]);
  assert.deepEqual(dashboardKey, [
    "/api/dashboard/widgets",
    "widget-1",
    "data",
  ]);
  assert.deepEqual(widgetDataQueryKey("widget-1", false, "canvas-instance-a"), dashboardKey);
});

test("WidgetCard consumes the canonical palette as normalized slots and chart colours", () => {
  const palette = normalizeDashboardWidgetPalette([
    { key: "default", label: "Brand", color: "#123abc" },
  ]);

  assert.equal(Array.isArray(palette), true);
  assert.deepEqual(
    dashboardWidgetChartColours(palette),
    palette.map((slot) => slot.color),
  );
  assert.equal(typeof palette[0], "object");
  assert.equal(typeof palette[0].color, "string");
});

function mountedWidgetElement({
  queryClient,
  widget,
  queryScope,
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WidgetCard
          widget={widget}
          embedded
          queryScope={queryScope}
          palette={normalizeDashboardWidgetPalette(null)}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

test(
  "mounted embedded scope transitions do not paint a previous identity payload",
  { concurrency: false },
  async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  const pending = [];
  globalThis.fetch = (url) => {
    requests.push(String(url));
    return new Promise((resolve) => pending.push(resolve));
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  const widget = {
    id: "widget-mounted",
    title: "Mounted list",
    widget_type: "list",
    height: "short",
    config: {},
  };
  const resolvePayload = async (rows) => {
    await act(async () => {
      // React Query may issue an initial stale refetch in addition to the
      // first request. Resolve all requests generated for this scope.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const resolves = pending.splice(0);
        assert.ok(resolves.length > 0, "a data request should be pending");
        resolves.forEach((resolve) =>
          resolve({
            ok: true,
            json: async () => ({ data: { type: "group", rows } }),
          }),
        );
        await new Promise((done) => setTimeout(done, 0));
        if (pending.length === 0) break;
      }
      // Let the observer notification and the final React commit settle
      // before assertions inspect the mounted DOM.
      await new Promise((done) => setTimeout(done, 0));
    });
  };

  try {
    await act(async () => {
      root.render(
        mountedWidgetElement({
          queryClient,
          widget,
          queryScope: "identity-a",
        }),
      );
      await Promise.resolve();
    });
    await resolvePayload([{ key: "Previous identity", value: 7 }]);
    assert.match(container.textContent, /Previous identity/);
    assert.match(requests[0], /\?embed=canvas$/);

    // A changed scope gets a new query with no placeholder data. The old
    // identity must disappear while the new request is in flight.
    await act(async () => {
      root.render(
        mountedWidgetElement({
          queryClient,
          widget,
          queryScope: "identity-b",
        }),
      );
      await Promise.resolve();
    });
    assert.doesNotMatch(container.textContent, /Previous identity/);
    assert.ok(container.querySelector('[data-testid="widget-loading-widget-mounted"]'));

    await resolvePayload([{ key: "Current identity", value: 3 }]);
    assert.match(container.textContent, /Current identity/);
    assert.doesNotMatch(container.textContent, /Previous identity/);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    document.body.removeChild(container);
    globalThis.fetch = previousFetch;
    TestResizeObserver.instances.length = 0;
  }
  },
);

test(
  "mounted embedded charts and lists stay bounded by measured content dimensions",
  { concurrency: false },
  async () => {
  const previousFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = () =>
    new Promise((resolve) => pending.push(resolve));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  const widget = {
    id: "widget-bounds",
    title: "Bounded widget",
    widget_type: "bar",
    height: "xxtall",
    config: {},
  };
  const payload = {
    type: "group",
    rows: [
      { key: "One", value: 4 },
      { key: "Two", value: 2 },
    ],
  };

  try {
    await act(async () => {
      root.render(
        mountedWidgetElement({
          container,
          queryClient,
          widget,
          queryScope: "bounds",
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      TestResizeObserver.flush({ width: 320, height: 180 });
      await Promise.resolve();
    });
    const resolve = pending.shift();
    assert.ok(resolve);
    resolve({ ok: true, json: async () => ({ data: payload }) });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
      await new Promise((done) => setTimeout(done, 0));
    });

    // ContentRect is the mounted content box, not the transformed/padded
    // getBoundingClientRect box used by the editor.
    await act(async () => {
      TestResizeObserver.flush({ width: 320, height: 180 });
      await Promise.resolve();
    });

    const card = container.querySelector('[data-testid="widget-card-widget-bounds"]');
    const chart = container.querySelector("[data-chart]");
    assert.ok(card?.className.includes("overflow-hidden"));
    assert.equal(chart?.style.height, "152px");

    // The same measured card can switch to a list without consulting the
    // saved xxtall preset; the list remains bounded and scrollable.
    const listWidget = { ...widget, widget_type: "list" };
    await act(async () => {
      root.render(
        mountedWidgetElement({
          queryClient,
          widget: listWidget,
          queryScope: "bounds",
        }),
      );
      await Promise.resolve();
    });
    const list = container.querySelector('[data-testid="widget-list-widget-bounds"]');
    assert.ok(list?.className.includes("min-h-0"));
    assert.ok(list?.className.includes("max-h-full"));
    assert.ok(card?.className.includes("overflow-hidden"));
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    document.body.removeChild(container);
    globalThis.fetch = previousFetch;
    TestResizeObserver.instances.length = 0;
  }
  },
);

test("embedded presentation keeps the canonical CSV export rows", () => {
  const rows = buildExportRows(
    { widget_type: "bar" },
    {
      type: "group",
      rows: [
        { key: "Members", value: 3 },
        { key: "Guests", value: 2 },
      ],
    },
  );

  assert.deepEqual(rows, [
    ["Label", "Value"],
    ["Members", 3],
    ["Guests", 2],
    ["Total", 5],
  ]);
});