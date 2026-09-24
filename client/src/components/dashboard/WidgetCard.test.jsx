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
  WidgetCacheStatus,
  WidgetBody,
  cachePollDelay,
  completedRefreshOutcome,
  mergeWidgetResponse,
  formatMembershipCurrency,
  widgetDataQueryKey,
  widgetRequestUrl,
} = await import("./WidgetCard.jsx");
const { describeWidgetConfig } = await import("@shared/widgetDescriber.js");
const { default: WidgetBuilderModal } = await import("./WidgetBuilderModal.jsx");
const { dashboardWidgetChartColours, normalizeDashboardWidgetPalette } =
  await import("@shared/dashboardWidgetPalette.js");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");

async function settleQuery() {
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
}

test("Cache warnings use a focusable header-sized icon with full error details", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <WidgetCacheStatus widgetId="compact-warning" cache={{
      status: "failed",
      updatedAt: "2026-09-24T18:00:00Z",
      error: "Unable to refresh widget. Please try again later.",
    }} />,
  ));
  const status = container.querySelector('[role="alert"]');
  const button = status.querySelector("button");
  assert.match(button.getAttribute("aria-label"), /Refresh failed.*Showing data updated.*Unable to refresh widget/);
  assert.ok(button.querySelector("svg"));
  assert.equal(status.querySelector("span").className, "sr-only");
  assert.ok(!status.className.includes("mb-2"));
  await act(async () => root.unmount());
  container.remove();
});

test("Stat cards omit redundant record counts while list totals remain", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <WidgetBody widget={{ id: "compact-stat", widget_type: "stat", config: {} }}
      payload={{ type: "scalar", value: 98, total: 98 }} />,
  ));
  assert.equal(container.textContent, "98");
  await act(async () => root.render(
    <WidgetBody widget={{ id: "list-total", widget_type: "list", config: {} }}
      payload={{ type: "group", rows: [{ key: "Events", value: 98 }], total: 98 }} />,
  ));
  assert.match(container.textContent, /Total/);
  assert.match(container.textContent, /98/);
  await act(async () => root.unmount());
  container.remove();
});

test("Annual membership value renders currency, exact basis and reconciliation warning", async () => {
  assert.match(formatMembershipCurrency(1234.5, "GBP"), /£1,234\.50/);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <WidgetBody
      widget={{
        id: "membership-value",
        widget_type: "stat",
        config: {
          source: "organisation_membership",
          membershipValue: { startMonth: 4, startYear: 2026, currency: "GBP" },
        },
      }}
      payload={{
        type: "scalar",
        value: 1200,
        membershipValue: {
          currency: "GBP",
          exactValue: "1200",
          period: { start: "2026-04-01", endExclusive: "2027-04-01", label: "2026-04-01 – 2027-03-31" },
          allocation: "membership_structure_effective_from_half_open",
          warnings: [{ code: "review", message: "One record needs review", count: 1 }],
        },
      }}
    />,
  ));
  assert.match(container.textContent, /£1,200\.00/);
  assert.match(container.textContent, /net of VAT/i);
  assert.match(container.textContent, /2026-04-01 – 2027-03-31/);
  assert.match(container.textContent, /effective date falls in this period/);
  assert.match(container.textContent, /Unpaid records are included/);
  assert.match(container.textContent, /Payments, refunds and credits are not reconciled/);
  assert.match(container.textContent, /One record needs review/);
  await act(async () => root.unmount());
  container.remove();
});

test("Annual membership value description states period, VAT and allocation semantics", () => {
  const text = describeWidgetConfig({
    source: "organisation_membership",
    membershipValue: {
      startMonth: 4,
      startYear: 2026,
      currency: "GBP",
      configIds: ["config-a"],
      bandIds: ["band-a"],
    },
    filters: [],
  });
  assert.match(text, /1 April 2026 to 31 March 2027/);
  assert.match(text, /exact 12-month period/);
  assert.match(text, /net of VAT/);
  assert.match(text, /unpaid membership records are included/i);
  assert.match(text, /payments, refunds and credits are not reconciled/i);
  assert.match(text, /currencies are never converted/);
  assert.match(text, /selected membership structures/);
  assert.match(text, /selected membership bands/);
});

test("Annual membership value never presents an incomplete zero as valid", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <WidgetBody
      widget={{ id: "incomplete-value", widget_type: "stat", config: { source: "organisation_membership", membershipValue: { currency: "GBP" } } }}
      payload={{
        type: "scalar",
        value: 0,
        membershipValue: {
          currency: "GBP",
          exactValue: "0",
          warnings: [{ code: "incomplete_zero", message: "The displayed zero is incomplete because eligible records lacked valuation evidence.", count: 1 }],
        },
      }}
    />,
  ));
  assert.match(container.textContent, /Unavailable/);
  assert.doesNotMatch(container.textContent, /£0\.00/);
  assert.match(container.textContent, /zero is incomplete/);
  await act(async () => root.unmount());
  container.remove();
});

test("Annual membership value builder preserves its dedicated config and hides generic controls", async () => {
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLSelectElement = window.HTMLSelectElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { type: "scalar", value: 1250, currency: "GBP" } }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  client.setQueryData(["/api/dashboard/sources"], {
    sources: [{
      id: "organisation_membership",
      label: "Annual Membership Value",
      membershipCatalog: {
        configs: [{ id: "config-a", name: "Corporate" }],
        bands: [{ id: "band-a", label: "Band A", config_id: "config-a" }],
        currencies: ["GBP"],
      },
      customFields: [{ id: "classification", label: "Classification", type: "enum", options: [] }],
      systemFields: [],
    }],
  });
  const config = {
    source: "organisation_membership",
    measure: { aggregator: "count", field: null, fieldKind: null, fieldId: null },
    membershipValue: {
      startMonth: 4,
      startYear: 2026,
      currency: "GBP",
      configIds: ["config-a"],
      bandIds: ["band-a"],
    },
    filters: [],
    helperText: "Annual value",
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let saved;
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <WidgetBuilderModal
          open
          initialWidget={{ title: "Annual value", widget_type: "stat", scope: "personal", config }}
          onClose={() => {}}
          onSave={value => { saved = value; }}
          canSavePersonal
        />
      </QueryClientProvider>,
    ));
    await settleQuery();
    assert.ok(document.querySelector('[data-testid="membership-value-controls"]'));
    assert.equal(document.querySelector('[data-testid="select-widget-type"]'), null);
    assert.equal(document.querySelector('[data-testid="select-widget-aggregator"]'), null);
    assert.equal(document.querySelector('[data-testid="select-widget-groupby"]'), null);
    assert.equal(document.querySelector('[data-testid="select-widget-timebucket-field"]'), null);
    assert.equal(document.querySelector('[data-testid="switch-widget-click-through"]'), null);
    const save = document.querySelector('[data-testid="button-save-widget"]');
    assert.ok(save);
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.equal(saved.widget_type, "stat");
    assert.deepEqual(saved.config.membershipValue, config.membershipValue);
    assert.equal(saved.config.helperText, "Annual value");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    globalThis.fetch = originalFetch;
  }
});

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
  assert.deepEqual(widgetDataQueryKey("widget-1", false, "member-a"), [
    "/api/dashboard/widgets",
    "widget-1",
    "data",
    "dashboard",
    "member-a",
  ]);
});

test("cache polling is bounded, backs off, and ignores merely overdue cache rows", () => {
  const state = { requestId: null, startedAt: 0, attempts: 0 };
  assert.equal(cachePollDelay({
    status: "stale",
    pending: false,
    retryAfterSeconds: 1,
  }, state, 1000), false);
  assert.equal(cachePollDelay({
    status: "stale",
    pending: true,
    requestId: "background-request",
    retryAfterSeconds: 1,
  }, state, 1000), 1000);

  const pending = {
    status: "pending",
    requestId: "request-a",
    refresh: { outcome: "queued" },
    retryAfterSeconds: 2,
  };
  assert.equal(cachePollDelay(pending, state, 1000), 2000);
  assert.equal(cachePollDelay(pending, state, 2000), 4000);
  assert.equal(cachePollDelay(pending, state, 3000), 8000);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    cachePollDelay(pending, state, 4000 + attempt);
  }
  assert.equal(cachePollDelay(pending, state, 9000), false);

  assert.equal(cachePollDelay({
    ...pending,
    requestId: "request-b",
    refresh: { outcome: "accepted" },
  }, state, 10000), 2000);
  assert.equal(state.attempts, 1);
  assert.equal(cachePollDelay({
    ...pending,
    requestId: "request-b",
    completedRequestId: "request-b",
    completedRequestOutcome: "success",
    refresh: { outcome: "accepted" },
  }, state, 11000), false);
  assert.equal(state.attempts, 0);
});

test("refresh metadata can update without hiding the last successful result", () => {
  const oldPayload = { type: "group", rows: [{ key: "Existing", value: 7 }] };
  const merged = mergeWidgetResponse(
    { data: oldPayload, cache: { status: "current" } },
    {
      data: null,
      cache: {
        status: "pending",
        requestId: "request-a",
        refresh: { outcome: "queued" },
      },
    },
  );
  assert.equal(merged.data, oldPayload);
  assert.equal(merged.cache.requestId, "request-a");
});

test("refresh completion is correlated for both success and failure", () => {
  assert.equal(completedRefreshOutcome({
    completedRequestId: "request-a",
    completedRequestOutcome: "success",
  }, "request-a"), "success");
  assert.equal(completedRefreshOutcome({
    completedRequestId: "request-a",
    completedRequestOutcome: "failed",
  }, "request-a"), "failed");
  assert.equal(completedRefreshOutcome({
    completedRequestId: "older-request",
    completedRequestOutcome: "failed",
  }, "request-a"), null);
});

test("pending cache metadata is announced while existing data refreshes", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <WidgetCacheStatus
        widgetId="pending"
        cache={{
          status: "pending",
          pending: true,
          updatedAt: "2026-09-18T10:15:00.000Z",
        }}
      />,
    ));
    const status = container.querySelector('[data-testid="widget-cache-status-pending"]');
    assert.equal(status?.getAttribute("role"), "status");
    assert.match(status?.textContent || "", /Refreshing · Showing data updated/);
    assert.ok(status?.querySelector(".animate-spin"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test(
  "cold pending polling times out, enables retry, and resets for a new identity",
  { concurrency: false },
  async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    let current = false;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => current
          ? {
              data: { type: "group", rows: [{ key: "Ready", value: 9 }] },
              cache: {
                status: "current",
                pending: false,
                updatedAt: "2026-09-18T10:20:00.000Z",
              },
            }
          : {
              data: null,
              cache: {
                status: "pending",
                pending: false,
                retryAfterSeconds: 0.001,
              },
            },
      };
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    const widget = {
      id: "cold-pending",
      title: "Cold pending",
      widget_type: "list",
      height: "short",
      config: {},
    };
    try {
      await act(async () => {
        root.render(mountedWidgetElement({
          queryClient,
          widget,
          queryScope: "identity-pending",
        }));
        await settleQuery();
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 750));
      });

      const refresh = container.querySelector(
        '[data-testid="button-refresh-widget-cold-pending"]',
      );
      assert.equal(refresh?.disabled, false);
      assert.equal(refresh?.getAttribute("aria-busy"), null);
      assert.match(container.textContent, /Refresh is taking longer than expected/);
      assert.ok(container.querySelector('[data-testid="widget-pending-timeout-cold-pending"]'));
      assert.equal(
        container.querySelector('[data-testid="widget-cache-status-cold-pending"] .animate-spin'),
        null,
      );
      assert.ok(calls > 1);
      assert.ok(calls <= 9, `polling should be bounded, received ${calls} calls`);

      current = true;
      await act(async () => {
        root.render(mountedWidgetElement({
          queryClient,
          widget,
          queryScope: "identity-ready",
        }));
      });
      await act(async () => {
        await settleQuery();
      });
      assert.match(container.textContent, /Ready/);
      assert.doesNotMatch(container.textContent, /taking longer than expected/);
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
      globalThis.fetch = previousFetch;
    }
  },
);

test(
  "authorized Canvas viewers can refresh one stale widget without hiding its cached data",
  { concurrency: false },
  async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    const updatedAt = "2026-09-18T10:15:00.000Z";
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      if (String(url).includes("/refresh")) {
        return {
          ok: true,
          json: async () => ({
            data: { type: "group", rows: [{ key: "Cached result", value: 7 }] },
            cache: {
              status: "current",
              updatedAt: "2026-09-18T10:16:00.000Z",
              pending: false,
              error: null,
              refresh: { outcome: "success" },
              completedRequestId: "request-1",
              completedRequestOutcome: "success",
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: { type: "group", rows: [{ key: "Cached result", value: 7 }] },
          cache: {
            status: "stale",
            updatedAt,
            pending: false,
            error: null,
          },
        }),
      };
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    const widget = {
      id: "widget-refresh",
      title: "Refreshable totals",
      widget_type: "list",
      height: "short",
      config: {},
    };
    queryClient.setQueryData(
      widgetDataQueryKey(widget.id, true, "viewer-a"),
      {
        data: { type: "group", rows: [{ key: "Cached result", value: 7 }] },
        cache: {
          status: "stale",
          updatedAt,
          pending: false,
          error: null,
        },
      },
    );

    try {
      await act(async () => {
        root.render(mountedWidgetElement({
          queryClient,
          widget,
          queryScope: "viewer-a",
        }));
        await settleQuery();
      });
      assert.match(container.textContent, /Cached result/);
      assert.match(container.textContent, /Stale · Last updated/);

      const refresh = container.querySelector(
        '[data-testid="button-refresh-widget-widget-refresh"]',
      );
      assert.ok(refresh);
      assert.equal(refresh.disabled, false);
      await act(async () => {
        refresh.click();
        await settleQuery();
      });

      assert.match(requests.at(-1), /\/refresh\?embed=canvas$/);
      assert.match(container.textContent, /Cached result/);
      assert.match(container.textContent, /Widget refreshed/);
      assert.equal(
        container.querySelector('[data-testid="widget-cache-status-widget-refresh"]')
          ?.getAttribute("role"),
        "status",
      );
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
      globalThis.fetch = previousFetch;
    }
  },
);

test(
  "a failed manual refresh reports an accessible error and preserves exportable data",
  { concurrency: false },
  async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/refresh")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: null,
            cache: {
              status: "current",
              updatedAt: "2026-09-18T10:15:00.000Z",
              retryAfterSeconds: 12,
              refresh: {
                outcome: "cooldown",
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: { type: "group", rows: [{ key: "Keep me", value: 4 }] },
          cache: {
            status: "current",
            updatedAt: "2026-09-18T10:15:00.000Z",
            pending: false,
            error: null,
          },
        }),
      };
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    const widget = {
      id: "widget-refresh-failure",
      title: "Failure-safe totals",
      widget_type: "list",
      height: "short",
      config: {},
    };

    try {
      await act(async () => {
        root.render(mountedWidgetElement({
          queryClient,
          widget,
          queryScope: "viewer-a",
        }));
        await settleQuery();
      });
      const refresh = container.querySelector(
        '[data-testid="button-refresh-widget-widget-refresh-failure"]',
      );
      await act(async () => {
        refresh.click();
        await settleQuery();
      });

      assert.match(container.textContent, /Keep me/);
      assert.match(container.textContent, /Refresh cooling down/);
      assert.match(container.textContent, /Updated/);
      assert.doesNotMatch(container.textContent, /Widget refreshed/);
      assert.equal(
        container.querySelector('[data-testid="widget-cache-status-widget-refresh-failure"]')
          ?.getAttribute("role"),
        "alert",
      );
      assert.ok(
        container.querySelector('[data-testid="button-widget-menu-widget-refresh-failure"]'),
      );
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
      globalThis.fetch = previousFetch;
    }
  },
);

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