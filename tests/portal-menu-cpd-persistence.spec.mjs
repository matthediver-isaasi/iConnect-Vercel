import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const HARNESS_ORIGIN = "http://portal-menu-cpd.test";
const PAGE_URL = `${HARNESS_ORIGIN}/PortalMenuManagement`;
const CAPTURE_PATH = path.resolve("screenshots/portal-menu-cpd-persistence.png");

let script;
let css;

const base44Mock = `
  const state = () => window.__portalMenuHarness;
  const copy = value => JSON.parse(JSON.stringify(value));
  export const base44 = {
    entities: {
      PortalMenu: {
        list: async () => copy(state().records),
        create: async data => {
          const record = { ...copy(data), id: "created-menu-item" };
          state().records.push(record);
          state().writes.push({ kind: "create", data: copy(data) });
          return copy(record);
        },
        update: async (id, data) => {
          const index = state().records.findIndex(item => item.id === id);
          state().records[index] = { ...state().records[index], ...copy(data) };
          state().writes.push({ kind: "update", id, data: copy(data) });
          return copy(state().records[index]);
        },
        delete: async () => null,
      },
      IEditPage: { filter: async () => [] },
      DynamicDirectory: { list: async () => [] },
      RoleAccessItem: { list: async () => [] },
    },
  };
`;

const accessMock = `
  export function useMemberAccess() {
    return { isFeatureExcluded: () => false, isAccessReady: true };
  }
`;

const portalLinksMock = `
  export const PORTAL_MENU_LINK_TYPES = { INTERNAL: "internal", EXTERNAL: "external" };
  export const getPortalMenuLinkType = item =>
    item?.link_type === "external" ? "external" : "internal";
  export const getCustomObjectIdFromPortalListUrl = () => null;
  export const getCustomObjectPortalRoleAccessId = id => "custom_object." + id + ".view";
  export const loadViewableCustomObjectPortalDestinations = async () => [];
  export const validatePortalMenuDestination = item => ({
    isValid: true,
    error: "",
    url: item?.url || "",
  });
  export const getPortalMenuFallbackFeatureId = item =>
    "page_" + (item.section === "admin" ? "admin" : "user") + "_" + (item.url || item.title);
`;

const sonnerMock = `
  export const toast = {
    success: message => window.__portalMenuHarness.toasts.push({ type: "success", message }),
    error: message => window.__portalMenuHarness.toasts.push({ type: "error", message }),
  };
`;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import PortalMenuManagement from "./client/src/pages/PortalMenuManagement.jsx";

        const queryClient = new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false },
          },
        });
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={queryClient}>
            <PortalMenuManagement />
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
      name: "portal-menu-cpd-mocks",
      setup(plugin) {
        const mocks = new Map([
          ["portal-menu-base44", base44Mock],
          ["portal-menu-access", accessMock],
          ["portal-menu-links", portalLinksMock],
          ["portal-menu-sonner", sonnerMock],
        ]);
        plugin.onResolve({ filter: /api[/\\]base44Client(?:\\.js)?$/ }, () => ({
          path: "portal-menu-base44", namespace: "portal-menu-mock",
        }));
        plugin.onResolve({ filter: /hooks[/\\]useMemberAccess(?:\\.js)?$/ }, () => ({
          path: "portal-menu-access", namespace: "portal-menu-mock",
        }));
        plugin.onResolve({ filter: /lib[/\\]portalMenuLinks(?:\\.js)?$/ }, () => ({
          path: "portal-menu-links", namespace: "portal-menu-mock",
        }));
        plugin.onResolve({ filter: /^sonner$/ }, () => ({
          path: "portal-menu-sonner", namespace: "portal-menu-mock",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "portal-menu-mock" }, ({ path: modulePath }) => ({
          contents: mocks.get(modulePath),
          loader: "js",
        }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: [
      "client/src/pages/PortalMenuManagement.jsx",
      "client/src/components/ui/{badge,button,card,command,dialog,input,label,popover,scroll-area,select,switch}.jsx",
    ],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

async function mount(page) {
  await page.route(`${HARNESS_ORIGIN}/**`, route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><body><div id="root"></div></body></html>',
  }));
  await page.goto(PAGE_URL);
  await page.evaluate(() => {
    window.__portalMenuHarness = {
      records: [{
        id: "existing-menu-item",
        title: "Professional development",
        url: "Events",
        link_type: "internal",
        open_in_new_tab: false,
        icon: "Award",
        feature_id: "events.existing-permission",
        section: "user",
        parent_id: "",
        display_order: 0,
        is_active: true,
      }],
      writes: [],
      toasts: [],
    };
  });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Portal Menu Management" })).toBeVisible();
}

test("selecting My CPD Points defaults its role and persists its lowercase route", async ({ page }) => {
  await mount(page);

  await page.getByRole("button", { name: "Edit Professional development" }).click();
  await expect(page.getByRole("dialog")).toContainText("Edit Menu Item");
  await expect(page.getByTestId("button-role-access-select"))
    .toContainText("events.existing-permission");

  await page.getByTestId("button-portal-page-select").click();
  await page.getByRole("option", { name: /My CPD Points/ }).click();

  await expect(page.getByTestId("button-portal-page-select")).toContainText("My CPD Points");
  await expect(page.getByTestId("button-portal-page-select")).toContainText("/CpdPoints");
  await expect(page.getByTestId("button-role-access-select")).toContainText("cpd.member_cpd");
  await page.getByRole("button", { name: "Update", exact: true }).click();

  await expect.poll(() => page.evaluate(() => window.__portalMenuHarness.writes)).toEqual([{
    kind: "update",
    id: "existing-menu-item",
    data: expect.objectContaining({
      url: "cpdpoints",
      feature_id: "cpd.member_cpd",
    }),
  }]);

  await page.getByRole("button", { name: "Edit Professional development" }).click();
  await expect(page.getByTestId("button-portal-page-select")).toContainText("My CPD Points");
  await expect(page.getByTestId("button-role-access-select")).toContainText("cpd.member_cpd");
  await page.screenshot({ path: CAPTURE_PATH, fullPage: true });
});

test("selecting Organisation Engagement Report replaces a stale permission and saves the canonical grant", async ({ page }) => {
  await mount(page);

  await page.getByRole("button", { name: "Edit Professional development" }).click();
  await expect(page.getByTestId("button-role-access-select"))
    .toContainText("events.existing-permission");

  await page.getByTestId("button-portal-page-select").click();
  await page.getByRole("option", { name: /Organisation Engagement Report/ }).click();

  await expect(page.getByTestId("button-portal-page-select"))
    .toContainText("Organisation Engagement Report");
  await expect(page.getByTestId("button-role-access-select"))
    .toContainText("reports.org-engagement");
  await page.getByRole("button", { name: "Update", exact: true }).click();

  await expect.poll(() => page.evaluate(() => window.__portalMenuHarness.writes)).toEqual([{
    kind: "update",
    id: "existing-menu-item",
    data: expect.objectContaining({
      url: "OrganisationEngagementReport",
      feature_id: "reports.org-engagement",
    }),
  }]);
});