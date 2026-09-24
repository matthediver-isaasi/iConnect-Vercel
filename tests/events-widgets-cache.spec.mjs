import { expect, test } from "@playwright/test";

const countMeasure = {
  aggregator: "count",
  field: null,
  fieldKind: null,
  fieldId: null,
};

const widgets = [
  {
    id: "events-kpi",
    title: "All events",
    widget_type: "stat",
    scope: "personal",
    width: "third",
    height: "short",
    config: { source: "event", measure: countMeasure, filters: [] },
  },
  ...["month", "quarter", "year"].map(granularity => ({
    id: `events-${granularity}`,
    title: `Events by ${granularity}`,
    widget_type: "line",
    scope: "personal",
    width: "third",
    height: "medium",
    config: {
      source: "event",
      measure: countMeasure,
      timeBucket: {
        field: "event_start_date",
        fieldKind: "system",
        fieldId: null,
        granularity,
      },
      filters: [],
    },
  })),
];

const results = {
  "events-kpi": { type: "scalar", value: 12, total: 12 },
  "events-month": {
    type: "time",
    rows: [{ key: "2026-01", value: 3 }, { key: "2026-02", value: 5 }],
    total: 8,
  },
  "events-quarter": {
    type: "time",
    rows: [{ key: "2026-Q1", value: 8 }, { key: "2026-Q2", value: 4 }],
    total: 12,
  },
  "events-year": {
    type: "time",
    rows: [{ key: "2025", value: 7 }, { key: "2026", value: 12 }],
    total: 19,
  },
};

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function viteModules(request) {
  const response = await request.get("/src/components/dashboard/WidgetCard.jsx");
  expect(response.ok()).toBeTruthy();
  const transformed = await response.text();
  const react = transformed.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error("The running preview must serve Vite React modules.");
  const dependency = name => react.replace(/react\.js\?/, `${name}.js?`);
  const paths = [
    "/@react-refresh",
    "/@vite/client",
    "/src/index.css",
    "/src/components/dashboard/WidgetCard.jsx",
    react,
    dependency("react-dom_client"),
    dependency("@tanstack_react-query"),
    dependency("react-router-dom"),
  ];
  const warmed = await Promise.all(paths.map(path => request.get(path)));
  for (const item of warmed) expect(item.ok()).toBeTruthy();
  return { react, dependency };
}

function fixtureHtml({ react, dependency }) {
  return `<!doctype html>
<html>
  <head><title>Saved Events widgets cache fixture</title></head>
  <body>
    <div id="root"></div>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import("/@vite/client");
      await import("/src/index.css");
      const React = (await import(${JSON.stringify(react)})).default;
      const { createRoot } = (await import(${JSON.stringify(dependency("react-dom_client"))})).default;
      const { QueryClient, QueryClientProvider } =
        await import(${JSON.stringify(dependency("@tanstack_react-query"))});
      const { MemoryRouter } = await import(${JSON.stringify(dependency("react-router-dom"))});
      const { default: WidgetCard } =
        await import("/src/components/dashboard/WidgetCard.jsx");
      const widgets = ${JSON.stringify(widgets)};
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
      });
      const cards = widgets.map(widget => React.createElement(
        "div",
        { key: widget.id, className: "min-w-0" },
        React.createElement(WidgetCard, {
          widget,
          queryScope: "events-cache-member",
          palette: [],
        }),
      ));
      createRoot(document.getElementById("root")).render(
        React.createElement(QueryClientProvider, { client },
          React.createElement(MemoryRouter, null,
            React.createElement("main", {
              className: "grid grid-cols-1 gap-4 p-6 md:grid-cols-2",
              "data-testid": "events-widget-fixture",
            }, cards),
          ),
        ),
      );
    </script>
  </body>
</html>`;
}

test("saved Events KPI and month, quarter and year trends survive a page reload", async ({
  page,
  request,
}) => {
  const modules = await viteModules(request);
  const fixturePath = "/__fixtures/events-widget-cache";
  const calls = new Map(widgets.map(widget => [widget.id, 0]));

  await page.route("**/*", async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === fixturePath) {
      return route.fulfill({
        contentType: "text/html",
        body: fixtureHtml(modules),
      });
    }
    const match = url.pathname.match(/^\/api\/dashboard\/widgets\/([^/]+)\/data$/);
    if (match) {
      const id = match[1];
      calls.set(id, (calls.get(id) || 0) + 1);
      const widget = widgets.find(item => item.id === id);
      return json(route, {
        widget,
        data: results[id],
        cache: {
          status: "current",
          pending: false,
          updatedAt: "2026-09-25T12:00:00.000Z",
        },
      });
    }
    if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      return route.abort();
    }
    return route.continue();
  });

  const assertCards = async () => {
    await expect(page.getByTestId("events-widget-fixture")).toBeVisible();
    await expect(page.getByTestId("stat-value-events-kpi")).toHaveText("12");
    for (const granularity of ["month", "quarter", "year"]) {
      const card = page.getByTestId(`widget-card-events-${granularity}`);
      await expect(card).toBeVisible();
      await expect(card.locator(".recharts-line-curve")).toHaveCount(1);
      await expect(page.getByTestId(`widget-cache-status-events-${granularity}`))
        .toContainText(/^Updated /);
    }
  };

  await page.goto(fixturePath);
  await assertCards();
  await page.reload();
  await assertCards();
  for (const widget of widgets) expect(calls.get(widget.id)).toBe(2);
});