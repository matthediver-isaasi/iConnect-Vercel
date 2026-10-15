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
      memberInfo: { tenant_id: state.tenantId || 'tenant-a', id: 'viewer' },
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

async function mount(page, access, fixture = {}) {
  const requests = [];
  await page.route(`${ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/reports/engagement-report") {
      if (url.searchParams.get('settings') === 'true') {
        if (fixture.failLoad) return route.fulfill({ status: 503, json: { error: 'Settings unavailable' } });
        if (route.request().method() === 'PUT') {
          if (fixture.failSave) return route.fulfill({ status: 503, json: { error: 'Save unavailable' } });
          const input = route.request().postDataJSON();
          fixture.settings = { ...fixture.settings, ...input, configured: true, revision: String(Date.now()) };
        }
        return route.fulfill({ json: fixture.settings || {
          configured: false, options: [], values: [], canManage: false,
        } });
      }
      requests.push(url.href);
      if (fixture.report) return route.fulfill({ json: fixture.report(fixture.settings) });
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

test('settings stay draft until saved, refresh report and CSV, survive remount, and display errors', async ({ page }) => {
  const fixture = {
    settings: { configured: false, field: { id: 'field-a' }, options: [
      { value: 'a', label: 'Type A' }, { value: 'b', label: 'Type B' },
    ], values: [], revision: null, canManage: true },
    report(settings) {
      const values = settings.configured ? settings.values : ['a', 'b'];
      const organizations = values.map((v, i) => ({
        organizationId: v, organizationName: `Organisation ${v}`, rank: i + 1,
        totalMembers: 1, activeMembers: 1, engagementRate: 100, trend: 'stable',
        trendDiff: 0, members: [{ id: v, name: `Member ${v}`, email: `${v}@example.test`, isActiveThisPeriod: true }],
      }));
      return { organizations, summary: { totalOrganizations: values.length, totalActiveMembers: values.length },
        period: { label: 'Fixture reporting period' } };
    },
  };
  const access = { ready: true, sessionValidated: true, excluded: [] };
  await mount(page, access, fixture);
  await expect(page.getByTestId('card-org-b')).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Type B', { exact: true }).uncheck();
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  await expect(page.getByTestId('card-org-b')).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  // Tabs unmount the editor; draft choices must remain while switching tabs.
  await expect(page.getByLabel('Type B', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  await expect(page.getByTestId('card-org-b')).toHaveCount(0);
  await expect(page.getByTestId('text-active-members')).toHaveText('1');
  await page.getByTestId('input-search').fill('not-present');
  await expect(page.getByTestId('text-no-data')).toHaveText('No organisations match your search');
  await page.getByTestId('input-search').fill('Member a');
  await expect(page.getByTestId('card-org-a')).toBeVisible();
  await page.evaluate(() => {
    window.__csv = null;
    URL.createObjectURL = blob => { blob.text().then(text => window.__csv = text); return 'blob:fixture'; };
    HTMLAnchorElement.prototype.click = () => {};
    URL.revokeObjectURL = () => {};
  });
  await page.getByTestId('button-export-csv').click();
  await expect.poll(() => page.evaluate(() => window.__csv)).toContain('Organisation a');
  expect(await page.evaluate(() => window.__csv)).not.toContain('Organisation b');
  await mount(page, access, fixture);
  await expect(page.getByTestId('card-org-b')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Type B', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Clear all' }).click();
  fixture.failSave = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Save unavailable');
  fixture.failSave = false;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  await expect(page.getByTestId('text-no-data')).toBeVisible();
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

test('report-only viewers see settings but cannot edit them; stale options stay visible', async ({ page }) => {
  await mount(page, { ready: true, sessionValidated: true, excluded: [] }, {
    settings: { configured: true, field: { id: 'field' }, canManage: false, revision: '1',
      values: ['removed'], options: [{ value: 'a', label: 'Type A' }],
      warning: 'Saved organisation types are no longer available.' },
  });
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('removed (removed option)', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Type A', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('no longer available');
});

test('loading errors are visible and retryable without offering editable defaults', async ({ page }) => {
  const fixture = { failLoad: true };
  await mount(page, { ready: true, sessionValidated: true, excluded: [] }, fixture);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Settings unavailable');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  fixture.failLoad = false;
  await page.getByRole('button', { name: 'Retry loading settings' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});