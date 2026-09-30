import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const ORIGIN = "http://nmc-journal-rbac.test";
const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://127.0.0.1:5000"),
).origin;
const JOURNAL_URL = "https://journals.lww.com/nuclearmedicinecomm/pages/default.aspx";
let bundle;
let css;

const portalItem = {
  id: "portal-nmc-journal",
  title: "NMC Journal",
  url: JOURNAL_URL,
  link_type: "external",
  open_in_new_tab: true,
  icon: "BookOpen",
  feature_id: "page_user_NMCJournal",
  section: "user",
  parent_id: "",
  display_order: 1,
  is_active: true,
};

const role = {
  id: "role-journal-editor",
  name: "Journal editor",
  description: "NMC Journal fixture role",
  excluded_features: ["content.nmc-journal"],
  show_tours: true,
  show_bookmarks: true,
  default_landing_page: "about-me",
  layout_theme: "default",
  segment_values: [],
  assignable_role_ids: [],
};

const roleAccessItems = [
  { id: "rai-content", item_key: "content", item_type: "module", label: "Content", display_order: 1, is_active: true },
  { id: "rai-nmc-journal", item_key: "content.nmc-journal", item_type: "page", parent_id: "rai-content", label: "NMC Journal", display_order: 1, is_active: true },
  { id: "rai-resources", item_key: "content.resources", item_type: "page", parent_id: "rai-content", label: "Resources", display_order: 2, is_active: true },
  { id: "rai-admin", item_key: "admin", item_type: "module", label: "Administration", display_order: 2, is_active: true },
  { id: "rai-role", item_key: "admin.role-management", item_type: "page", parent_id: "rai-admin", label: "Role Management", display_order: 1, is_active: true },
];

const base44Mock = `
  const initialPortal = ${JSON.stringify([portalItem])};
  const initialRoles = ${JSON.stringify([role])};
  const accessItems = ${JSON.stringify(roleAccessItems)};

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function read(key, fallback) {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : clone(fallback);
  }
  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function record(kind, args) {
    const calls = read("__nmc_rbac_calls", []);
    calls.push({ kind, args: clone(args) });
    write("__nmc_rbac_calls", calls);
  }

  const PortalMenu = {
    list: async () => clone(read("__nmc_portal_items", initialPortal)),
    update: async (id, data) => {
      record("PortalMenu.update", [id, data]);
      const rows = read("__nmc_portal_items", initialPortal);
      const updated = { ...rows.find(row => row.id === id), ...clone(data), id };
      write("__nmc_portal_items", rows.map(row => row.id === id ? updated : row));
      return clone(updated);
    },
    create: async data => {
      record("PortalMenu.create", [data]);
      const created = { ...clone(data), id: "created-menu" };
      write("__nmc_portal_items", [...read("__nmc_portal_items", initialPortal), created]);
      return clone(created);
    },
    delete: async id => {
      record("PortalMenu.delete", [id]);
      write("__nmc_portal_items", read("__nmc_portal_items", initialPortal).filter(row => row.id !== id));
      return { success: true };
    },
  };
  const Role = {
    list: async () => clone(read("__nmc_roles", initialRoles)),
    update: async (id, data) => {
      record("Role.update", [id, data]);
      const rows = read("__nmc_roles", initialRoles);
      const updated = { ...rows.find(row => row.id === id), ...clone(data), id };
      write("__nmc_roles", rows.map(row => row.id === id ? updated : row));
      return clone(updated);
    },
    create: async data => ({ ...clone(data), id: "created-role" }),
    delete: async () => ({ success: true }),
  };
  const empty = { list: async () => [], filter: async () => [] };
  export const base44 = {
    entities: {
      PortalMenu,
      Role,
      RoleAccessItem: { list: async () => clone(accessItems) },
      IEditPage: empty,
      DynamicDirectory: empty,
      SystemSettings: empty,
      PreferenceField: empty,
      ResourceCategory: empty,
    },
  };
`;

const accessMock = `
  export function useMemberAccess() {
    const denied = JSON.parse(localStorage.getItem("__nmc_denied") || "[]");
    return {
      isAccessReady: true,
      isFeatureExcluded: key => denied.includes(key),
    };
  }
`;

const supabaseMock = `
  export const supabase = {
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: value => ({ data: { publicUrl: String(value) } }),
      }),
    },
  };
`;

const sonnerMock = `
  function push(type, message) {
    const values = JSON.parse(localStorage.getItem("__nmc_toasts") || "[]");
    values.push({ type, message });
    localStorage.setItem("__nmc_toasts", JSON.stringify(values));
  }
  export const toast = {
    success: message => push("success", message),
    error: message => push("error", message),
  };
`;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { BrowserRouter } from "react-router-dom";
        import PortalMenuManagement from "./client/src/pages/PortalMenuManagement.jsx";
        import RoleManagement from "./client/src/pages/RoleManagement.jsx";

        const queryClient = new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false },
          },
        });
        const Page = location.pathname === "/RoleManagement"
          ? RoleManagement
          : location.pathname === "/PortalMenuManagement"
            ? PortalMenuManagement
            : () => null;
        createRoot(document.getElementById("root")).render(
          <BrowserRouter>
            <QueryClientProvider client={queryClient}>
              <Page />
            </QueryClientProvider>
          </BrowserRouter>
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
      "import.meta.env.VITE_SUPABASE_URL": '"https://fixture.invalid"',
      "import.meta.env.VITE_SUPABASE_ANON_KEY": '"fixture"',
    },
    plugins: [{
      name: "nmc-journal-rbac-mocks",
      setup(plugin) {
        plugin.onResolve({ filter: /api[/\\]base44Client(?:\\.js)?$/ }, () => ({
          path: "base44",
          namespace: "nmc-rbac-mock",
        }));
        plugin.onResolve({ filter: /hooks[/\\]useMemberAccess(?:\\.js)?$/ }, () => ({
          path: "access",
          namespace: "nmc-rbac-mock",
        }));
        plugin.onResolve({ filter: /api[/\\]supabaseClient(?:\\.js)?$/ }, () => ({
          path: "supabase",
          namespace: "nmc-rbac-mock",
        }));
        plugin.onResolve({ filter: /^sonner$/ }, () => ({
          path: "sonner",
          namespace: "nmc-rbac-mock",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "nmc-rbac-mock" }, ({ path: modulePath }) => ({
          contents: modulePath === "base44"
            ? base44Mock
            : modulePath === "access"
              ? accessMock
              : modulePath === "supabase"
                ? supabaseMock
                : sonnerMock,
          loader: "js",
        }));
      },
    }],
  });
  bundle = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: [
      "client/src/pages/{PortalMenuManagement,RoleManagement}.jsx",
      "client/src/components/ui/*.jsx",
    ],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

async function installHarness(page, { denied = [] } = {}) {
  await page.addInitScript(({ initialPortal, initialRoles, deniedKeys }) => {
    if (!localStorage.getItem("__nmc_portal_items")) {
      localStorage.setItem("__nmc_portal_items", JSON.stringify(initialPortal));
    }
    if (!localStorage.getItem("__nmc_roles")) {
      localStorage.setItem("__nmc_roles", JSON.stringify(initialRoles));
    }
    localStorage.setItem("__nmc_denied", JSON.stringify(deniedKeys));
    localStorage.setItem("__nmc_rbac_calls", localStorage.getItem("__nmc_rbac_calls") || "[]");
  }, { initialPortal: [portalItem], initialRoles: [role], deniedKeys: denied });

  // Routes run newest-first. Install the HTML fallback before assets/API so
  // the more specific fixture contracts win on reload as well as first load.
  await page.route(`${ORIGIN}/**`, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`,
  }));
  await page.route(`${ORIGIN}/bundle.js`, route => route.fulfill({
    contentType: "application/javascript",
    body: bundle,
  }));
  await page.route(`${ORIGIN}/styles.css`, route => route.fulfill({
    contentType: "text/css",
    body: css,
  }));
  await page.route(`${ORIGIN}/api/**`, route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      return route.fulfill({
        status: 599,
        contentType: "application/json",
        body: JSON.stringify({ error: `Unexpected fixture mutation ${request.method()} ${request.url()}` }),
      });
    }
    const url = new URL(request.url());
    if (url.pathname === "/api/admin/roles/member-counts") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ counts: {} }) });
    }
    if (url.pathname === "/api/custom-objects") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], total: 0 }) });
    }
    return route.fulfill({ contentType: "application/json", body: "[]" });
  });
}

function fulfillJson(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function installProductionSidebarFixture(page, { exclusions = ["admin"] } = {}) {
  const member = {
    id: "member-nmc-journal",
    email: "nmc-journal@example.invalid",
    first_name: "NMC",
    last_name: "Journal",
    tenant_id: "tenant-nmc-journal",
    role_id: "role-nmc-journal",
    organization_id: null,
    is_team_member: true,
    member_excluded_features: [],
  };
  // The baseline is deliberately a non-admin member role. Individual test
  // phases may remove this exclusion only when explicitly checking admin nav.
  const state = { exclusions: [...exclusions], writes: [], unexpectedExternal: [] };
  const currentRole = () => ({
    id: member.role_id,
    name: "NMC Journal sidebar role",
    excluded_features: [...state.exclusions],
  });
  const menu = [
    { ...portalItem },
    {
      id: "portal-role-management",
      title: "Role Management",
      url: "RoleManagement",
      link_type: "internal",
      open_in_new_tab: false,
      icon: "Shield",
      feature_id: "admin.role-management",
      section: "admin",
      parent_id: "",
      display_order: 1,
      is_active: true,
    },
  ];

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
  });
  await page.context().route("**/rest/v1/**", route => fulfillJson(route, []));
  await page.context().routeWebSocket("**/realtime/v1/websocket*", socket => {
    socket.onMessage(() => {});
  });
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== APP_ORIGIN) {
      if (["fonts.googleapis.com", "fonts.gstatic.com", "teeone.pythonanywhere.com",
        "cdnjs.cloudflare.com", "js.stripe.com", "va.vercel-scripts.com"].includes(url.hostname)) {
        return route.fulfill({ status: 204, body: "" });
      }
      if (url.hostname.endsWith(".supabase.co")) return fulfillJson(route, []);
      state.unexpectedExternal.push(`${method} ${url.href}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(`${method} ${url.pathname}`);
      return fulfillJson(route, { error: "Read-only NMC Journal sidebar fixture" }, 599);
    }
    if (url.pathname === "/api/auth/me") {
      return fulfillJson(route, {
        ...member,
        sessionRole: {
          status: "ready",
          member_id: member.id,
          tenant_id: member.tenant_id,
          role_id: member.role_id,
          role: currentRole(),
        },
      });
    }
    if (url.pathname === "/api/auth/tenant-user-me") {
      return fulfillJson(route, { authenticated: false }, 401);
    }
    if (url.pathname === "/api/entities/PortalMenu") return fulfillJson(route, menu);
    if (url.pathname === "/api/entities/RoleAccessItem") return fulfillJson(route, roleAccessItems);
    if (url.pathname === `/api/entities/Role/${member.role_id}`) return fulfillJson(route, currentRole());
    if (url.pathname === "/api/entities/Role") return fulfillJson(route, [currentRole()]);
    if (url.pathname === "/api/entities/Member") return fulfillJson(route, [member]);
    if (url.pathname === "/api/public/page/nmc-journal-sidebar-fixture") {
      return fulfillJson(route, {
        success: true,
        page: {
          id: "page-nmc-journal-sidebar-fixture",
          slug: "nmc-journal-sidebar-fixture",
          title: "NMC Journal sidebar fixture",
          status: "published",
          builder_type: "canvas",
          layout_type: "member",
          public_chrome: "both",
          hide_chrome: false,
          tenant_id: member.tenant_id,
          canvas_design: {
            version: 1,
            root: {
              background: null,
              groups: [],
              guides: { vertical: [], horizontal: [] },
              sections: [{
                id: "section-nmc-journal",
                type: "section",
                children: [{
                  id: "copy-nmc-journal",
                  type: "custom-html",
                  name: "Fixture content",
                  geom: { x: 0, y: 0, w: 800, h: 100 },
                  bp: {
                    desktop: { x: 0, y: 0, w: 800, h: 100 },
                    tablet: { x: 0, y: 0, w: 700, h: 100 },
                    mobile: { x: 0, y: 0, w: 350, h: 100 },
                  },
                  style: { background: "#fff", opacity: 1, zIndex: 1 },
                  content: { html: "<p>NMC Journal sidebar fixture content</p>" },
                }],
              }],
            },
          },
        },
        elements: [],
        symbols: [],
      });
    }
    if (url.pathname === "/api/public/tenant-branding") {
      return fulfillJson(route, {
        success: true,
        branding: {
          id: member.tenant_id,
          name: "NMC Journal fixture",
          headerConfig: {},
          footerConfig: {},
          platformBranding: { enabled: false },
        },
      });
    }
    if (url.pathname === "/api/public/portal-branding") {
      return fulfillJson(route, { tenantName: "NMC Journal fixture", homePageSlug: "nmc-journal-sidebar-fixture" });
    }
    if (url.pathname === "/api/custom-objects") return fulfillJson(route, { objects: [], data: [], total: 0 });
    if (url.pathname === "/api/communication/inbox/unread-count") return fulfillJson(route, { unreadCount: 0 });
    if (url.pathname === "/api/public/favicon-url") return fulfillJson(route, { faviconUrl: null });
    if (url.pathname.startsWith("/api/redirects/resolve")) return fulfillJson(route, { found: false });
    return fulfillJson(route, []);
  });
  return state;
}

async function editPortalItem(page) {
  const row = page.getByText("NMC Journal", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'border')][1]");
  await row.locator("button:has(svg.lucide-pencil)").click();
  return page.getByRole("dialog", { name: "Edit Menu Item" });
}

test("PortalMenuManagement saves NMC Journal canonical access without changing its external destination and reloads it", async ({ page }) => {
  await installHarness(page);
  await page.goto(`${ORIGIN}/PortalMenuManagement`);
  await expect(page.getByRole("heading", { name: "Portal Menu Management" })).toBeVisible();

  let dialog = await editPortalItem(page);
  await expect(dialog.getByTestId("button-role-access-select")).toContainText("page_user_NMCJournal");
  await expect(dialog.getByTestId("select-portal-link-type")).toContainText("External website");
  await expect(dialog.getByTestId("input-portal-external-url")).toHaveValue(
    "https://journals.lww.com/nuclearmedicinecomm/pages/default.aspx",
  );
  await expect(dialog.getByTestId("switch-portal-external-new-tab")).toBeChecked();
  await dialog.getByTestId("button-role-access-select").click();
  await page.getByTestId("input-role-access-search").fill("content.nmc-journal");
  await page.getByTestId("option-role-access-content.nmc-journal").click();
  await expect(dialog.getByTestId("button-role-access-select")).toContainText("content.nmc-journal");
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem("__nmc_rbac_calls") || "[]"));
  expect(calls).toContainEqual({
    kind: "PortalMenu.update",
    args: [
      "portal-nmc-journal",
      expect.objectContaining({
        url: "https://journals.lww.com/nuclearmedicinecomm/pages/default.aspx",
        link_type: "external",
        open_in_new_tab: true,
        feature_id: "content.nmc-journal",
        section: "user",
      }),
    ],
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Portal Menu Management" })).toBeVisible();
  dialog = await editPortalItem(page);
  await expect(dialog.getByTestId("button-role-access-select")).toContainText("content.nmc-journal");
  await expect(dialog.getByText("Current: content.nmc-journal", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("input-portal-external-url")).toHaveValue(
    "https://journals.lww.com/nuclearmedicinecomm/pages/default.aspx",
  );
  await expect(dialog.getByTestId("switch-portal-external-new-tab")).toBeChecked();
});

test("RoleManagement renders the NMC Journal Content page and enforces direct, parent, sibling, and admin toggle state", async ({ page }) => {
  await installHarness(page);
  await page.goto(`${ORIGIN}/RoleManagement`);
  await expect(page.getByRole("heading", { name: "Role Management" })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Edit Role" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Content", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("switch-module-content")).toBeChecked();
  await expect(dialog.getByTestId("switch-module-content").locator("xpath=..")).toContainText("Partial");

  await dialog.getByTestId("button-expand-module-content").click();
  await expect(dialog.getByTestId("switch-page-content.nmc-journal")).not.toBeChecked();
  await expect(dialog.getByTestId("switch-page-content.resources")).toBeChecked();

  await dialog.getByTestId("switch-module-content").click();
  await expect(dialog.getByTestId("switch-module-content")).not.toBeChecked();
  await expect(dialog.getByTestId("switch-page-content.nmc-journal")).toBeDisabled();
  await expect(dialog.getByTestId("switch-page-content.resources")).toBeDisabled();
  await dialog.getByTestId("switch-module-content").click();
  await expect(dialog.getByTestId("switch-module-content")).toBeChecked();
  await expect(dialog.getByTestId("switch-page-content.nmc-journal")).toBeEnabled();
  await expect(dialog.getByTestId("switch-page-content.nmc-journal")).toBeChecked();
  await expect(dialog.getByTestId("switch-page-content.resources")).toBeChecked();

  await dialog.getByTestId("button-expand-module-admin").click();
  await expect(dialog.getByTestId("switch-page-admin.role-management")).toBeVisible();
  await expect(dialog.getByTestId("switch-page-admin.role-management")).toBeChecked();
  await dialog.getByTestId("switch-page-admin.role-management").click();
  await expect(dialog.getByTestId("switch-page-admin.role-management")).not.toBeChecked();
  await expect(dialog.getByTestId("switch-module-admin").locator("xpath=..")).toContainText("Blocked");
});

test("production sidebar filters NMC Journal for non-admin canonical, legacy, and Content-parent exclusions", async ({ page }) => {
  const state = await installProductionSidebarFixture(page);
  await page.goto(`${APP_ORIGIN}/nmc-journal-sidebar-fixture`);
  await expect(page.getByText("NMC Journal sidebar fixture content", { exact: true })).toBeVisible();

  const journal = page.getByRole("link", { name: "NMC Journal", exact: true });
  const roleManagement = page.getByRole("link", { name: "Role Management", exact: true });
  await expect(journal).toBeVisible();
  await expect(journal).toHaveAttribute("href", JOURNAL_URL);
  await expect(journal).toHaveAttribute("target", "_blank");
  await expect(journal).toHaveAttribute("rel", /noopener/);
  await expect(roleManagement).toHaveCount(0);

  state.exclusions = ["admin", "content.nmc-journal"];
  await page.reload();
  await expect(journal).toHaveCount(0);
  await expect(roleManagement).toHaveCount(0);

  state.exclusions = ["admin", "page_user_NMCJournal"];
  await page.reload();
  await expect(journal).toHaveCount(0);
  await expect(roleManagement).toHaveCount(0);

  state.exclusions = ["admin", "content"];
  await page.reload();
  await expect(journal).toHaveCount(0);
  await expect(roleManagement).toHaveCount(0);

  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

test("production sidebar preserves explicitly permitted admin navigation without bypassing NMC Journal access", async ({ page }) => {
  const state = await installProductionSidebarFixture(page, { exclusions: [] });
  await page.goto(`${APP_ORIGIN}/nmc-journal-sidebar-fixture`);

  const journal = page.getByRole("link", { name: "NMC Journal", exact: true });
  const roleManagement = page.getByRole("link", { name: "Role Management", exact: true });
  await expect(journal).toBeVisible();
  await expect(roleManagement).toBeVisible();

  // A direct journal deny still applies to this admin-permitted role, proving
  // that showing admin navigation does not act as a blanket access bypass.
  state.exclusions = ["content.nmc-journal"];
  await page.reload();
  await expect(journal).toHaveCount(0);
  await expect(roleManagement).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.unexpectedExternal).toEqual([]);
});

for (const [pathname, deniedKey, redirectPath] of [
  ["/PortalMenuManagement", "system.portal-menu", "/Events"],
  ["/RoleManagement", "page_RoleManagement", "/about-me"],
]) {
  test(`${pathname} denies excluded members and redirects to ${redirectPath}`, async ({ page }) => {
    await installHarness(page, { denied: [deniedKey] });
    await page.goto(`${ORIGIN}${pathname}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => new URL(page.url()).pathname).toBe(redirectPath);
  });
}