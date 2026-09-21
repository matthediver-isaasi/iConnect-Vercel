import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.DocumentFragment = dom.window.DocumentFragment;
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
  WidgetBody,
  widgetDataQueryKey,
  widgetRequestUrl,
} = await import("./WidgetCard.jsx");
const { default: WidgetBuilderModal } = await import("./WidgetBuilderModal.jsx");
const { dashboardWidgetChartColours, normalizeDashboardWidgetPalette } =
  await import("@shared/dashboardWidgetPalette.js");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");

test("Member Groups list renders missing history and provisional values without clickthrough or summed headcounts", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let clicks = 0;
  await act(async () => root.render(
    <WidgetBody
      widget={{ id: "history", widget_type: "list", config: { source: "member_group", measure: { field: "period_end_members" }, clickThrough: true } }}
      payload={{ type: "time", categories: ["value"], historyBaseline: "2026-09-01T00:00:00Z", rows: [{ key: "2026-08", value: null, available: false }, { key: "2026-09", value: 0, provisional: true }] }}
      onDrill={() => { clicks++; }}
    />,
  ));
  assert.match(container.textContent, /Unavailable/);
  assert.match(container.textContent, /Current \/ provisional: 2026-09/);
  assert.match(container.textContent, /Reliable history starts 2026-09-01/);
  assert.match(container.textContent, /not an overall headcount/);
  assert.equal(container.querySelector('[role="button"]'), null);
  assert.equal(clicks, 0);
  assert.doesNotMatch(container.textContent, /Total: 0/);
  await act(async () => root.unmount());
  container.remove();
});

test("Member Groups named monthly line chart keeps separate labelled series and unavailable CSV values", async () => {
  const widget = { id: "group-lines", widget_type: "line", config: { source: "member_group", measure: { field: "period_end_members" } } };
  const payload = {
    type: "time", categories: ["group_a", "group_b"], seriesLabels: { group_a: "Clinical Group", group_b: "Research Group" },
    rows: [
      { key: "2026-08", group_a: null, group_b: null, available: false },
      { key: "2026-09", group_a: 2, group_b: 3, available: true, provisional: true },
    ],
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<WidgetBody widget={widget} payload={payload} />));
  await act(async () => TestResizeObserver.flush({ width: 600, height: 300 }));
  assert.match(container.textContent, /Clinical Group/);
  assert.match(container.textContent, /Research Group/);
  assert.equal(container.querySelectorAll(".recharts-line").length, 2);
  assert.deepEqual(buildExportRows(widget, payload), [
    ["Label", "Clinical Group", "Research Group", "Status"],
    ["2026-08", "Unavailable", "Unavailable", "Unavailable"],
    ["2026-09", 2, 3, "Current / provisional"],
  ]);
  await act(async () => root.unmount());
  container.remove();
});

test("Member Groups builder reopens and saves named monthly series in personal and shared scope", async () => {
  // Radix dialogs use constructors and focus APIs from the browser realm.
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLSelectElement = window.HTMLSelectElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { type: "time", categories: ["Group A"], rows: [] } }) });
  try {
    for (const scope of ["personal", "shared"]) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
      client.setQueryData(["/api/dashboard/sources"], { sources: [{
        id: "member_group", label: "Member Groups",
        systemFields: [{ name: "group_id", label: "Group", type: "reference" }, { name: "membership_at", label: "Membership history date", type: "date" }],
      }] });
      const config = {
        source: "member_group", measure: { aggregator: "count", fieldKind: "system", field: "period_end_members", fieldId: null },
        timeBucket: { field: "membership_at", fieldKind: "system", granularity: "month", window: { amount: 12, unit: "month" } },
        seriesBy: { kind: "system", field: "group_id" }, filters: [], cumulative: false,
      };
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      let saved;
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <WidgetBuilderModal open initialWidget={{ title: "Membership at month end", widget_type: "line", scope, config }}
            onClose={() => {}} onSave={value => { saved = value; }} canSaveShared />
        </QueryClientProvider>,
      ));
      const save = document.querySelector('[data-testid="button-save-widget"]');
      assert.ok(save);
      assert.equal(save.disabled, false);
      assert.equal(document.querySelector('[data-testid="switch-group-series"]').getAttribute("aria-checked"), "true");
      assert.equal(document.querySelector('[data-testid="switch-widget-cumulative"]'), null);
      assert.equal(document.querySelector('[data-testid="switch-widget-click-through"]'), null);
      await act(async () => save.click());
      assert.equal(saved.scope, scope);
      assert.deepEqual(saved.config.measure, config.measure);
      assert.deepEqual(saved.config.timeBucket, config.timeBucket);
      assert.deepEqual(saved.config.seriesBy, config.seriesBy);
      await act(async () => root.unmount());
      container.remove();
      client.clear();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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