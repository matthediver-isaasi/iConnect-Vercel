import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const HARNESS_ORIGIN = "http://badge-management.test";
const PAGE_URL = `${HARNESS_ORIGIN}/BadgeManagement`;
const PAGE_SIZE = 12;

let script;
let css;

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function badge(id, name, is_active = true) {
  return {
    id,
    name,
    description: `${name} description`,
    image_url: `https://images.example.test/${id}.png`,
    is_active,
  };
}

const baseMock = `
  function harness() {
    if (!window.__badgeHarness) throw new Error("Badge harness is not installed");
    return window.__badgeHarness;
  }

  function copy(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function responseFor(kind, args) {
    const state = harness();
    const callsKey = kind === "list" ? "listCalls" : "mutationCalls";
    state[callsKey] ||= [];
    state[callsKey].push({
      kind,
      args: copy(args),
      at: Date.now(),
    });

    const queueKey = kind === "list" ? "listResponses" : kind + "Responses";
    const queue = state[queueKey] || [];
    const spec = queue.length ? queue.shift() : {};
    const delay = Number(spec.delay || 0);
    const error = spec.reject || spec.error;
    const body = Object.prototype.hasOwnProperty.call(spec, "body") ? spec.body : spec;

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (error) {
          reject(new Error(String(error)));
        } else {
          resolve(copy(body));
        }
      }, delay);
    });
  }

  export const base44 = {
    entities: {
      Badge: {
        list: (...args) => responseFor("list", args),
        create: (...args) => responseFor("create", args),
        update: (...args) => responseFor("update", args),
        delete: (...args) => responseFor("delete", args),
      },
    },
  };
`;

const accessMock = `
  const access = {
    isFeatureExcluded: feature => Boolean(window.__badgeHarness?.accessExcluded && feature === "admin.badges"),
    isAccessReady: true,
  };
  export function useMemberAccess() {
    return access;
  }
`;

const brandingMock = `
  export function useTenantBranding() {
    return { branding: window.__badgeHarness?.branding || null };
  }
`;

const supabaseMock = `
  export const supabase = {
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: path => ({ data: { publicUrl: String(path) } }),
      }),
    },
  };
`;

const sonnerMock = `
  export const toast = {
    success: message => (window.__badgeHarness.toasts ||= []).push({ type: "success", message }),
    error: message => (window.__badgeHarness.toasts ||= []).push({ type: "error", message }),
  };
`;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import BadgeManagement from "./client/src/pages/BadgeManagement.jsx";

        const queryClient = new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false },
          },
        });
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={queryClient}>
            <BadgeManagement />
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
    define: {
      "process.env.NODE_ENV": '"test"',
      "import.meta.env.VITE_SUPABASE_URL": '"https://images.example.test"',
    },
    plugins: [{
      name: "badge-management-task-4427-mocks",
      setup(plugin) {
        plugin.onResolve({ filter: /api[/\\]base44Client(?:\\.js)?$/ }, () => ({
          path: "badge-management-base44",
          namespace: "badge-management-mock",
        }));
        plugin.onResolve({ filter: /hooks[/\\]useMemberAccess(?:\\.js)?$/ }, () => ({
          path: "badge-management-access",
          namespace: "badge-management-mock",
        }));
        plugin.onResolve({ filter: /contexts[/\\]TenantBrandingContext(?:\\.jsx)?$/ }, () => ({
          path: "badge-management-branding",
          namespace: "badge-management-mock",
        }));
        plugin.onResolve({ filter: /api[/\\]supabaseClient(?:\\.js)?$/ }, () => ({
          path: "badge-management-supabase",
          namespace: "badge-management-mock",
        }));
        plugin.onResolve({ filter: /^sonner$/ }, () => ({
          path: "badge-management-sonner",
          namespace: "badge-management-mock",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "badge-management-mock" }, ({ path: modulePath }) => ({
          contents: modulePath === "badge-management-base44"
            ? baseMock
            : modulePath === "badge-management-access"
              ? accessMock
              : modulePath === "badge-management-branding"
                ? brandingMock
                : modulePath === "badge-management-supabase"
                  ? supabaseMock
                  : sonnerMock,
          loader: "js",
        }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: [
      "client/src/pages/BadgeManagement.jsx",
      "client/src/components/badges/BadgeImageLink.jsx",
      "client/src/components/ui/{alert-dialog,badge,button,card,dialog,input,label,switch,textarea,PaginationPageButton}.jsx",
    ],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

async function mount(page, fixture) {
  await page.route(`${HARNESS_ORIGIN}/**`, route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><body><div id="root"></div></body></html>',
  }));
  await page.goto(PAGE_URL);
  await page.evaluate(state => {
    window.__badgeHarness = state;
    window.__badgeHarness.listCalls = [];
    window.__badgeHarness.mutationCalls = [];
    window.__badgeHarness.toasts = [];
  }, jsonClone(fixture));
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
}

async function waitForLoadedPage(page) {
  await expect(page.getByTestId("text-badges-title")).toBeVisible();
  await expect(page.getByText("Showing", { exact: false })).toBeVisible();
}

async function listCalls(page) {
  return page.evaluate(() => window.__badgeHarness.listCalls);
}

async function mutationCalls(page) {
  return page.evaluate(() => window.__badgeHarness.mutationCalls);
}

test("renders exact-count toolbar, applies combined filters after debounce, and clears search", async ({ page }) => {
  await mount(page, {
    listResponses: [
      { body: { data: [badge("alpha-1", "Alpha One"), badge("alpha-2", "Alpha Two")], count: 25 } },
      { body: { data: [badge("alpha-1", "Alpha One")], count: 2 } },
      { body: { data: [badge("alpha-1", "Alpha One")], count: 1 } },
      { body: { data: [badge("active-1", "Active One")], count: 1 } },
    ],
  });
  await waitForLoadedPage(page);

  await expect(page.getByRole("searchbox", { name: "Search badges" })).toBeVisible();
  const status = page.getByRole("combobox", { name: "Status" });
  await expect(status).toHaveJSProperty("tagName", "SELECT");
  await expect(status.locator("option")).toHaveText(["All statuses", "Active", "Inactive"]);
  await expect(page.getByText("Showing 1–12 of 25 badges", { exact: true })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search badges" });
  await search.fill("alpha");
  await page.waitForTimeout(250);
  expect((await listCalls(page)).length).toBe(1);
  await page.waitForTimeout(100);
  await expect.poll(async () => (await listCalls(page)).length).toBe(2);
  await expect(page.getByText("Showing 1–2 of 2 badges", { exact: true })).toBeVisible();

  await status.selectOption("active");
  await expect.poll(async () => (await listCalls(page)).length).toBe(3);
  const combined = (await listCalls(page))[2].args[0];
  expect(combined).toMatchObject({
    filter: { name: { ilike: "%alpha%" }, is_active: true },
    limit: PAGE_SIZE,
    offset: 0,
    queryParams: { count: "exact" },
  });
  expect(combined.sort).toEqual({ created_date: "desc", id: "desc" });
  await expect(page.getByRole("button", { name: "Clear search" })).toBeEnabled();

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect.poll(async () => (await listCalls(page)).length).toBe(4);
  const cleared = (await listCalls(page))[3].args[0];
  expect(cleared.filter).toEqual({ is_active: true });
  await expect(search).toHaveValue("");
  await expect(page.getByText("Showing 1–1 of 1 badges", { exact: true })).toBeVisible();
});

test("debounces search and ignores a stale response from an older query", async ({ page }) => {
  await mount(page, {
    listResponses: [
      { body: { data: [badge("initial", "Initial")], count: 1 } },
      { delay: 700, body: { data: [badge("old", "Old response")], count: 1 } },
      { delay: 10, body: { data: [badge("new", "New response")], count: 1 } },
    ],
  });
  await waitForLoadedPage(page);

  const search = page.getByRole("searchbox", { name: "Search badges" });
  await search.fill("old");
  await page.waitForTimeout(250);
  expect((await listCalls(page)).length).toBe(1);
  await page.waitForTimeout(100);
  await expect.poll(async () => (await listCalls(page)).length).toBe(2);

  await search.fill("new");
  await page.waitForTimeout(300);
  await expect.poll(async () => (await listCalls(page)).length).toBe(3);
  await expect(page.getByTestId("text-badge-name-new")).toHaveText("New response");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("text-badge-name-new")).toHaveText("New response");
  await expect(page.getByTestId("text-badge-name-old")).toHaveCount(0);
});

test("uses the Badge regex filter for literal-star searches", async ({ page }) => {
  await mount(page, {
    listResponses: [
      { body: { data: [badge("initial", "Initial")], count: 1 } },
      { body: { data: [badge("star", "A*.[x]")], count: 1 } },
    ],
  });
  await waitForLoadedPage(page);

  await page.getByRole("searchbox", { name: "Search badges" }).fill("A*.[x]");
  await page.waitForTimeout(350);
  await expect.poll(async () => (await listCalls(page)).length).toBe(2);
  expect((await listCalls(page))[1].args[0].filter).toEqual({
    name: { imatch: "A\\*\\.\\[x\\]" },
  });
  await expect(page.getByTestId("text-badge-name-star")).toHaveText("A*.[x]");
});

test("keeps pagination within boundaries and exposes labelled page buttons", async ({ page }) => {
  await mount(page, {
    listResponses: [
      {
        body: {
          data: Array.from({ length: 12 }, (_, i) => badge(`page-1-${i}`, `Page One ${i + 1}`)),
          count: 25,
        },
      },
      {
        body: {
          data: Array.from({ length: 12 }, (_, i) => badge(`page-2-${i}`, `Page Two ${i + 1}`)),
          count: 25,
        },
      },
      { body: { data: [badge("page-3-0", "Page Three One")], count: 25 } },
      {
        body: {
          data: Array.from({ length: 12 }, (_, i) => badge(`page-2b-${i}`, `Page Two Again ${i + 1}`)),
          count: 25,
        },
      },
    ],
  });
  await waitForLoadedPage(page);

  await expect(page.getByText("Showing 1–12 of 25 badges", { exact: true })).toBeVisible();
  const previous = page.getByRole("button", { name: "Previous", exact: true });
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(previous).toHaveAccessibleName("Previous");
  await expect(next).toHaveAccessibleName("Next");
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  for (const number of [1, 2, 3]) {
    await expect(page.getByRole("button", { name: `Page ${number}`, exact: true })).toBeVisible();
  }

  await next.click();
  await expect(page.getByText("Showing 13–24 of 25 badges", { exact: true })).toBeVisible();
  await expect(previous).toBeEnabled();

  await page.getByRole("button", { name: "Page 3", exact: true }).click();
  await expect(page.getByText("Showing 25–25 of 25 badges", { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  const callsBeforeBoundaryClick = (await listCalls(page)).length;
  await next.evaluate(button => button.click());
  expect((await listCalls(page)).length).toBe(callsBeforeBoundaryClick);

  await previous.click();
  await expect(page.getByText("Showing 13–24 of 25 badges", { exact: true })).toBeVisible();
});

test("shows list errors with retry, plus distinct empty and no-match states", async ({ page }) => {
  await mount(page, {
    listResponses: [
      { reject: "Badge service unavailable" },
      { body: { data: [], count: 0 } },
      { body: { data: [], count: 0 } },
    ],
  });
  await expect(page.getByRole("alert")).toHaveText("Unable to load badges. Please try again.");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No badges yet", { exact: true })).toBeVisible();
  await expect(page.getByText("Showing 0–0 of 0 badges", { exact: true })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search badges" }).fill("missing");
  await page.waitForTimeout(350);
  await expect(page.getByText("No matching badges", { exact: true })).toBeVisible();
  await expect(page.getByText("Try a different name or status.", { exact: true })).toBeVisible();
  await expect(page.getByText("Showing 0–0 of 0 badges", { exact: true })).toBeVisible();
});

for (const outcome of ["deleted", "deactivated"]) {
test(`supports edit and ${outcome} actions when the final active page is removed`, async ({ page }) => {
  await mount(page, {
    listResponses: [
      {
        body: {
          data: Array.from({ length: 12 }, (_, i) => badge(`first-${i}`, `First ${i + 1}`)),
          count: 13,
        },
      },
      {
        body: {
          data: Array.from({ length: 12 }, (_, i) => badge(`first-${i}`, `First ${i + 1}`)),
          count: 13,
        },
      },
      { body: { data: [badge("last", "Last page badge")], count: 13 } },
      { body: { data: [badge("last", "Edited last page badge")], count: 13 } },
      { body: { data: [], count: 12 } },
      {
        body: {
          data: Array.from({ length: 12 }, (_, i) => badge(`after-delete-${i}`, `After delete ${i + 1}`)),
          count: 12,
        },
      },
    ],
    updateResponses: [{ body: { ...badge("last", "Edited last page badge") } }],
    deleteResponses: [{ body: { outcome } }],
  });
  await waitForLoadedPage(page);
  await page.getByLabel("Status", { exact: true }).selectOption("active");
  await expect.poll(async () => (await listCalls(page)).length).toBe(2);
  await page.getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(page.getByTestId("card-badge-last")).toBeVisible();
  await expect(page.getByText("Showing 13–13 of 13 badges", { exact: true })).toBeVisible();

  await page.getByTestId("button-edit-badge-last").click();
  await expect(page.getByRole("dialog")).toContainText("Edit Badge");
  await page.getByTestId("input-badge-name").fill("Edited last page badge");
  await page.getByTestId("button-save-badge").click();
  await expect.poll(async () => (await mutationCalls(page)).some(call => call.kind === "update")).toBe(true);
  const updateCall = (await mutationCalls(page)).find(call => call.kind === "update");
  expect(updateCall.args).toEqual(["last", expect.objectContaining({
    name: "Edited last page badge",
    is_active: true,
  })]);
  await expect(page.getByTestId("text-badge-name-last")).toHaveText("Edited last page badge");

  await page.getByTestId("button-delete-badge-last").click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByTestId("button-confirm-delete-badge").click();
  await expect.poll(async () => (await mutationCalls(page)).some(call => call.kind === "delete")).toBe(true);
  expect((await mutationCalls(page)).find(call => call.kind === "delete").args).toEqual(["last"]);
  await expect(page.getByText("Showing 1–12 of 12 badges", { exact: true })).toBeVisible();
  await expect(page.getByTestId("card-badge-last")).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => window.__badgeHarness.toasts)))
    .toContainEqual({ type: "success", message: outcome === "deactivated" ? "Badge deactivated" : "Badge deleted" });
  expect((await listCalls(page)).slice(1).every(call => call.args[0].filter.is_active === true)).toBe(true);
});
}

test("keeps controls usable on a narrow screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await mount(page, {
    listResponses: [{ body: { data: [badge("mobile", "Founding member")], count: 60 } }],
  });
  await waitForLoadedPage(page);
  await expect(page.getByLabel("Status", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("badge-library-mobile.png"), fullPage: true });
});

test("gates the page before querying and redirects excluded members", async ({ page }) => {
  await mount(page, {
    accessExcluded: true,
    listResponses: [{ body: { data: [badge("unexpected", "Unexpected")], count: 1 } }],
  });
  await expect.poll(() => page.url()).toBe(`${HARNESS_ORIGIN}/Events`);
  await expect(page.getByTestId("text-badges-title")).toHaveCount(0);
});
