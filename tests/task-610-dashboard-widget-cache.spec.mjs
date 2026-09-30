import { test, expect } from "@playwright/test";

const MANY_WIDGETS = Array.from({ length: 18 }, (_, index) => ({
  id: `cache-widget-${index + 1}`,
  title: `Cached metric ${index + 1}`,
  widget_type: "stat",
  scope: index % 2 ? "personal" : "shared",
  width: "third",
  height: "short",
  config: { source: "member", measure: { aggregator: "count" } },
}));

const CANVAS_WIDGETS = [
  {
    id: "canvas-cache-a",
    title: "Canvas cached members",
    widget_type: "stat",
    scope: "shared",
    width: "half",
    height: "short",
    config: { source: "member", measure: { aggregator: "count" } },
  },
  {
    id: "canvas-cache-b",
    title: "Canvas cached organisations",
    widget_type: "stat",
    scope: "shared",
    width: "half",
    height: "short",
    config: { source: "organization", measure: { aggregator: "count" } },
  },
];

const CURRENT_AT = "2026-09-24T11:45:00.000Z";
const STALE_AT = "2026-09-24T10:15:00.000Z";

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function viteModulePaths(request) {
  const response = await request.get("/src/components/dashboard/WidgetCard.jsx");
  expect(response.ok()).toBeTruthy();
  const transformed = await response.text();
  const reactModule = transformed.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  if (!reactModule) {
    throw new Error("The existing preview must serve Vite-transformed React modules.");
  }
  const modules = {
    react: reactModule,
    dependency: name => reactModule.replace(/react\.js\?/, `${name}.js?`),
  };
  // A fresh isolated Vite process may still be materialising optimized
  // dependencies after transforming WidgetCard. Warm every fixture import
  // before navigation so the first browser test is as reliable as later ones.
  const warmPaths = [
    "/@react-refresh",
    "/@vite/client",
    "/src/index.css",
    "/src/components/dashboard/WidgetCard.jsx",
    modules.react,
    modules.dependency("react-dom_client"),
    modules.dependency("@tanstack_react-query"),
    modules.dependency("react-router-dom"),
  ];
  const warmed = await Promise.all(warmPaths.map(path => request.get(path)));
  for (const response of warmed) expect(response.ok()).toBeTruthy();
  return modules;
}

function fixtureHtml({ react, dependency }, widgets, { embedded }) {
  return `<!doctype html>
<html>
  <head><title>Dashboard widget cache browser fixture</title></head>
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
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
      });
      const cards = widgets.map(widget => React.createElement(
        "div",
        { key: widget.id, className: "min-w-0" },
        React.createElement(WidgetCard, {
          widget,
          embedded: ${JSON.stringify(embedded)},
          queryScope: ${JSON.stringify(embedded ? "canvas-cache-fixture-member" : "dashboard-cache-fixture-member")},
          palette: [],
        }),
      ));
      createRoot(document.getElementById("root")).render(
        React.createElement(QueryClientProvider, { client: queryClient },
          React.createElement(MemoryRouter, null,
            React.createElement("main", {
              className: "grid grid-cols-1 gap-4 p-6 md:grid-cols-3",
              "data-testid": ${JSON.stringify(embedded ? "canvas-cache-fixture" : "many-widget-cache-fixture")},
            }, cards),
          ),
        ),
      );
    </script>
  </body>
</html>`;
}

test("many-widget dashboard paints warm results and refreshes only the selected card", async ({
  page,
  request,
}, testInfo) => {
  const modules = await viteModulePaths(request);
  const fixturePath = "/__fixtures/task-610-many-widget-cache";
  const calls = [];
  const values = new Map(MANY_WIDGETS.map((widget, index) => [widget.id, index + 101]));

  await page.route("**/*", async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === fixturePath) {
      return route.fulfill({
        contentType: "text/html",
        body: fixtureHtml(modules, MANY_WIDGETS, { embedded: false }),
      });
    }
    const match = url.pathname.match(/^\/api\/dashboard\/widgets\/([^/]+)\/(data|refresh)$/);
    if (match) {
      const [, id, action] = match;
      calls.push({ id, action, method: req.method(), embed: url.searchParams.get("embed") });
      const requestId = action === "refresh" ? `refresh-${id}` : null;
      return json(route, {
        widget: MANY_WIDGETS.find(widget => widget.id === id),
        data: { type: "scalar", value: values.get(id), total: values.get(id) },
        cache: {
          status: "current",
          pending: false,
          updatedAt: action === "refresh" ? "2026-09-24T12:00:00.000Z" : CURRENT_AT,
          ...(requestId && {
            completedRequestId: requestId,
            completedRequestOutcome: "success",
            refresh: { outcome: "success" },
          }),
        },
      });
    }
    if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      return route.abort();
    }
    return route.continue();
  });

  await page.goto(fixturePath);
  const cards = page.locator("[data-testid^='widget-card-cache-widget-']");
  await expect(cards).toHaveCount(MANY_WIDGETS.length);
  await expect(page.getByTestId("widget-card-cache-widget-1")).toContainText("101");
  await expect(page.getByTestId("widget-card-cache-widget-18")).toContainText("118");
  await expect(page.getByTestId("widget-cache-status-cache-widget-1")).toContainText("Updated");
  await expect.poll(() => calls.filter(call => call.action === "data").length)
    .toBe(MANY_WIDGETS.length);

  await page.getByTestId("button-refresh-widget-cache-widget-7").click();
  // The aggregate is intentionally unchanged; request correlation, rather
  // than a numeric difference, confirms that this refresh completed.
  await expect(page.getByTestId("widget-card-cache-widget-7")).toContainText("107");
  await expect(page.getByTestId("widget-cache-status-cache-widget-7"))
    .toContainText("Widget refreshed.");
  expect(calls.filter(call => call.action === "refresh")).toEqual([{
    id: "cache-widget-7",
    action: "refresh",
    method: "POST",
    embed: null,
  }]);
  await expect(page.getByTestId("widget-card-cache-widget-6")).toContainText("106");
  await page.screenshot({
    path: testInfo.outputPath("many-widget-warm-cache-and-selected-refresh.png"),
    fullPage: true,
  });
});

test("Canvas keeps stale data visible through pending and failed refresh states", async ({
  page,
  request,
}, testInfo) => {
  const modules = await viteModulePaths(request);
  const fixturePath = "/__fixtures/task-610-canvas-widget-cache";
  const calls = [];
  let refreshRequested = false;

  await page.route("**/*", async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === fixturePath) {
      return route.fulfill({
        contentType: "text/html",
        body: fixtureHtml(modules, CANVAS_WIDGETS, { embedded: true }),
      });
    }
    const match = url.pathname.match(/^\/api\/dashboard\/widgets\/([^/]+)\/(data|refresh)$/);
    if (match) {
      const [, id, action] = match;
      calls.push({ id, action, method: req.method(), embed: url.searchParams.get("embed") });
      const widget = CANVAS_WIDGETS.find(item => item.id === id);
      if (action === "refresh") {
        refreshRequested = true;
        return json(route, {
          widget,
          data: { type: "scalar", value: 71, total: 71 },
          cache: {
            status: "pending",
            pending: true,
            requestId: "canvas-refresh-a",
            updatedAt: STALE_AT,
            retryAfterSeconds: 1,
            refresh: { outcome: "queued" },
          },
        });
      }
      if (id === "canvas-cache-a" && refreshRequested) {
        return json(route, {
          widget,
          data: { type: "scalar", value: 71, total: 71 },
          cache: {
            status: "failed",
            pending: false,
            updatedAt: STALE_AT,
            error: "Upstream report timed out",
            completedRequestId: "canvas-refresh-a",
            completedRequestOutcome: "failed",
            refresh: { outcome: "failed" },
          },
        });
      }
      const stale = id === "canvas-cache-a";
      return json(route, {
        widget,
        data: {
          type: "scalar",
          value: stale ? 71 : 28,
          total: stale ? 71 : 28,
        },
        cache: {
          status: stale ? "stale" : "current",
          pending: false,
          updatedAt: stale ? STALE_AT : CURRENT_AT,
        },
      });
    }
    if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      return route.abort();
    }
    return route.continue();
  });

  await page.goto(fixturePath);
  const staleCard = page.getByTestId("widget-card-canvas-cache-a");
  const currentCard = page.getByTestId("widget-card-canvas-cache-b");
  await expect(staleCard).toContainText("71");
  await expect(currentCard).toContainText("28");
  await expect(page.getByTestId("widget-cache-status-canvas-cache-a"))
    .toContainText(/Stale · Last updated/);
  await expect(page.getByTestId("widget-cache-status-canvas-cache-b"))
    .toContainText(/^Updated /);
  // An overdue/stale row is not active work and must not create a polling
  // loop before a user explicitly requests a refresh.
  await page.waitForTimeout(1_200);
  expect(calls.filter(call => call.id === "canvas-cache-a" && call.action === "data"))
    .toHaveLength(1);

  const refresh = page.getByTestId("button-refresh-widget-canvas-cache-a");
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  // The last successful payload remains visible while the replacement is pending.
  await expect(staleCard).toContainText("71");
  await expect(page.getByTestId("widget-cache-status-canvas-cache-a"))
    .toContainText("Refresh requested.");
  expect(calls.filter(call => call.action === "refresh")).toEqual([{
    id: "canvas-cache-a",
    action: "refresh",
    method: "POST",
    embed: "canvas",
  }]);

  await expect(page.getByTestId("widget-cache-status-canvas-cache-a"))
    .toContainText(/Upstream report timed out/, { timeout: 5_000 });
  await expect(page.getByTestId("widget-cache-status-canvas-cache-a")).toHaveAttribute("role", "alert");
  await expect(staleCard).toContainText("71");
  await expect(currentCard).toContainText("28");
  expect(calls.filter(call => call.action === "refresh" && call.id === "canvas-cache-b")).toHaveLength(0);
  expect(calls.filter(call => call.id === "canvas-cache-a").every(call => call.embed === "canvas"))
    .toBe(true);

  await page.screenshot({
    path: testInfo.outputPath("canvas-stale-data-after-failed-refresh.png"),
    fullPage: true,
  });
});