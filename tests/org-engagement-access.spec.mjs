import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const ORIGIN = "http://org-engagement-access.test";
let script;

const accessMock = `
  import { useSyncExternalStore } from "react";

  function subscribe(listener) {
    window.addEventListener("fixture-access-change", listener);
    return () => window.removeEventListener("fixture-access-change", listener);
  }

  export function useMemberAccess() {
    const state = useSyncExternalStore(
      subscribe,
      () => window.__orgEngagementAccess,
      () => window.__orgEngagementAccess,
    );
    return {
      isAccessReady: state.ready,
      sessionValidated: state.sessionValidated,
      isFeatureExcluded: featureId => state.excluded.includes(featureId),
    };
  }
`;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import OrganisationEngagementReport from "./client/src/pages/OrganisationEngagementReport.jsx";

        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        });
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={queryClient}>
            <OrganisationEngagementReport />
          </QueryClientProvider>
        );
      `,
      resolveDir: process.cwd(),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    alias: { "@": path.resolve("client/src") },
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{
      name: "org-engagement-access-mock",
      setup(plugin) {
        plugin.onResolve({ filter: /hooks[/\\]useMemberAccess(?:\\.js)?$/ }, () => ({
          path: "org-engagement-access",
          namespace: "org-engagement-mock",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "org-engagement-mock" }, () => ({
          contents: accessMock,
          loader: "js",
          resolveDir: process.cwd(),
        }));
      },
    }],
  });
  script = result.outputFiles[0].text;
});

async function mount(page, access) {
  const requests = [];
  await page.route(`${ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/reports/engagement-report") {
      requests.push(url.href);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          organizations: [],
          summary: {},
          period: { label: "Fixture reporting period" },
        }),
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><div id="root"></div></body></html>',
    });
  });
  await page.goto(`${ORIGIN}/OrganisationEngagementReport`);
  await page.evaluate(initial => {
    window.__orgEngagementAccess = initial;
    window.__setOrgEngagementAccess = next => {
      window.__orgEngagementAccess = next;
      window.dispatchEvent(new Event("fixture-access-change"));
    };
  }, access);
  await page.addScriptTag({ content: script });
  return requests;
}

test("validated permission renders and queries, then live revocation hides and redirects", async ({ page }) => {
  const requests = await mount(page, {
    ready: true,
    sessionValidated: true,
    excluded: [],
  });
  await expect(page.getByTestId("text-page-title"))
    .toHaveText("Organisation Engagement Report");
  await expect.poll(() => requests.length).toBe(1);

  await page.evaluate(() => window.__setOrgEngagementAccess({
    ready: true,
    sessionValidated: true,
    excluded: ["reports.org-engagement"],
  }));

  await expect(page).toHaveURL(`${ORIGIN}/Events`);
  await expect(page.getByTestId("text-page-title")).toHaveCount(0);
  expect(requests).toHaveLength(1);
});

test("guest access redirects without issuing a report query", async ({ page }) => {
  const requests = await mount(page, {
    ready: true,
    sessionValidated: false,
    excluded: [],
  });
  await expect(page).toHaveURL(`${ORIGIN}/Events`);
  expect(requests).toHaveLength(0);
});