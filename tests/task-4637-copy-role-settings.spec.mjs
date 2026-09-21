import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

/*
 * This suite mounts the real RoleManagement copy dialog and MemberPreferences.
 * Entity calls and HTTP are fixture-only; unexpected writes and transports fail.
 */
const roles = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Source Editors",
    description: "Source role",
    excluded_features: ["page_admin_RoleManagement"],
    is_active: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Target Reviewers",
    description: "Target role",
    excluded_features: ["page_Events"],
    is_active: true,
  },
];

const initialPermissions = {
  "00000000-0000-4000-8000-000000000001": { first_name: "read", last_name: "read_write", profile_photo_url: "read" },
  "00000000-0000-4000-8000-000000000002": { first_name: "hidden", last_name: "hidden", profile_photo_url: "hidden" },
};

function resolveSource(base) {
  for (const candidate of [
    base, `${base}.jsx`, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`,
    path.join(base, "index.jsx"), path.join(base, "index.js"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return base;
}

const stubs = {
  "@/api/base44Client": `
    const clone = value => structuredClone(value);
    const list = name => {
      window.__task4637.entityReads.push(name);
      if (name === "Role") return clone(window.__task4637.roles);
      if (name === "PreferenceField") return [];
      return clone(window.__task4637.entityLists[name] || []);
    };
    const entity = name => ({
      list: async () => list(name),
      filter: async () => list(name),
      get: async () => null,
      create: async (...args) => {
        window.__task4637.unexpectedWrites.push([name, "create", args]);
        throw new Error("Unexpected fixture entity create");
      },
      update: async (...args) => {
        window.__task4637.unexpectedWrites.push([name, "update", args]);
        throw new Error("Unexpected fixture entity update");
      },
      delete: async (...args) => {
        window.__task4637.unexpectedWrites.push([name, "delete", args]);
        throw new Error("Unexpected fixture entity delete");
      },
    });
    export const base44 = {
      entities: new Proxy({}, { get: (_target, name) => entity(name) }),
      functions: { invoke: async () => ({ data: [] }) },
    };
  `,
  "@/api/supabaseClient": `
    const result = { data: [], error: null };
    const chain = new Proxy({}, {
      get(_target, key) {
        if (key === "then") return resolve => resolve(result);
        return () => chain;
      },
    });
    export const supabase = {
      from: () => chain,
      storage: { from: () => ({ upload: async () => result, getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
      channel: () => chain,
      removeChannel: () => {},
    };
  `,
  "@/hooks/useMemberAccess": `
    export const useMemberAccess = () => ({
      isAccessReady: true, authResolved: true, sessionValidated: true,
      isFeatureExcluded: () => false, isAdmin: true,
      memberInfo: { id: "fixture-admin" }, memberRole: { id: "fixture-admin-role" },
    });
  `,
  "@/utils": `export const createPageUrl = name => "/" + name;`,
  "@/components/PermissionMatrix": `
    export default function FixturePermissionMatrix({ permissionsByRole, isLoading }) {
      return <div>
        <span data-testid="fixture-permissions-loading">{String(isLoading)}</span>
        <span data-testid="fixture-target-permission">
          {permissionsByRole?.["00000000-0000-4000-8000-000000000002"]?.first_name || "not-loaded"}
        </span>
      </div>;
    }
  `,
};

function fixturePlugin() {
  return {
    name: "task-4637-isolated-role-pages",
    setup(api) {
      api.onResolve({ filter: /^@\// }, args => {
        if (stubs[args.path]) return { path: args.path, namespace: "task4637-stub" };
        return { path: resolveSource(path.resolve("client/src", args.path.slice(2))) };
      });
      api.onResolve({ filter: /^@shared\// }, args => ({
        path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
      }));
      api.onLoad({ filter: /.*/, namespace: "task4637-stub" }, args => ({
        contents: stubs[args.path],
        loader: "jsx",
        resolveDir: process.cwd(),
      }));
      api.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
    },
  };
}

let script;
let styles;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { useEffect } from "react";
        import { createRoot } from "react-dom/client";
        import { BrowserRouter } from "react-router-dom";
        import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
        import { Toaster } from "sonner";
        import RoleManagement from "./client/src/pages/RoleManagement.jsx";
        import MemberPreferences from "./client/src/pages/MemberPreferences.jsx";
        import { subscribeRoleSettingsCopy } from "./client/src/lib/roleSettingsCopy.js";

        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
        });
        function ProductionRefreshBridge() {
          const client = useQueryClient();
          useEffect(() => subscribeRoleSettingsCopy(() => {
            void client.cancelQueries().then(() => client.invalidateQueries());
          }), [client]);
          return null;
        }
        function Harness() {
          return <>
            <ProductionRefreshBridge />
            <RoleManagement />
            {window.__task4637.includePreferences ? <MemberPreferences /> : null}
            <Toaster />
          </>;
        }
        createRoot(document.getElementById("root")).render(
          <BrowserRouter>
            <QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>
          </BrowserRouter>
        );
      `,
      resolveDir: process.cwd(),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [fixturePlugin()],
  });
  script = result.outputFiles[0].text;
  styles = (await postcss([tailwindcss({ config: "tailwind.config.ts" })])
    .process(fs.readFileSync("client/src/index.css", "utf8"), { from: "client/src/index.css" })).css;
});

async function mount(page, options = {}) {
  const requests = [];
  const unexpectedTransports = [];
  const runtimeErrors = [];
  const permissions = structuredClone(initialPermissions);
  page.on("pageerror", error => runtimeErrors.push(error.message));
  let releaseCopy;
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "roles.test" && request.isNavigationRequest()) {
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    }
    if (url.hostname !== "roles.test") {
      unexpectedTransports.push(`${request.method()} ${request.url()}`);
      return route.abort();
    }
    if (url.pathname === "/api/admin/roles/member-counts" && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"counts":{}}' });
    }
    if (url.pathname === "/api/roles/bulk-field-permissions" &&
        url.searchParams.get("type") === "member" && request.method() === "GET") {
      requests.push({ method: "GET", path: `${url.pathname}${url.search}` });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(permissions) });
    }
    if (url.pathname === "/api/admin/roles/copy-settings" && request.method() === "POST") {
      const body = request.postDataJSON();
      requests.push({ method: "POST", path: url.pathname, body });
      if (options.pending) await new Promise(resolve => { releaseCopy = resolve; });
      if (options.failureStatus) {
        return route.fulfill({
          status: options.failureStatus,
          contentType: "application/json",
          body: JSON.stringify({ error: options.failureMessage || "Copy forbidden by fixture" }),
        });
      }
      if (options.malformedSuccess) {
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"copied":true}' });
      }
      permissions[body.targetRoleId] = structuredClone(permissions[body.sourceRoleId]);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: roles.find(role => role.id === body.targetRoleId) }),
      });
    }
    unexpectedTransports.push(`${request.method()} ${url.pathname}${url.search}`);
    return route.abort();
  });
  await page.goto("http://roles.test/RoleManagement");
  await page.evaluate(fixture => {
    window.__task4637 = {
      roles: structuredClone(fixture.roles),
      permissions: structuredClone(fixture.permissions),
      includePreferences: fixture.includePreferences,
      entityLists: {},
      entityReads: [],
      unexpectedWrites: [],
    };
  }, { roles, permissions: initialPermissions, includePreferences: !!options.includePreferences });
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("button-copy-role-settings")).toBeEnabled();
  return {
    requests,
    unexpectedTransports,
    runtimeErrors,
    releaseCopy: () => releaseCopy?.(),
    unexpectedWrites: () => page.evaluate(() => window.__task4637.unexpectedWrites),
  };
}

async function chooseRoles(page) {
  await page.getByLabel("Copy from (source role)").selectOption("00000000-0000-4000-8000-000000000001");
  await page.getByLabel("Replace settings on (target role)").selectOption("00000000-0000-4000-8000-000000000002");
}

const copyDialog = page => page.getByRole("dialog", { name: "Copy settings to an existing role" });

test("selection names the destructive source and target, and Cancel performs no write", async ({ page }) => {
  const fixture = await mount(page);
  await page.getByTestId("button-copy-role-settings").click();
  const dialog = copyDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Only saved settings are copied");
  await expect(page.getByRole("button", { name: "Replace target settings" })).toBeDisabled();

  await chooseRoles(page);
  await expect(dialog).toContainText(
    "Replace all access settings and Member Preferences role field permissions on Target Reviewers with those from Source Editors",
  );
  await expect(dialog).toContainText("replaced, not merged");
  await expect(dialog).toContainText("cannot be undone");
  await expect(page.getByLabel(/I confirm replacing settings on Target Reviewers/)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Replace target settings" })).toBeDisabled();
  await page.getByLabel(/I confirm replacing settings on Target Reviewers/).check();
  await expect(page.getByRole("button", { name: "Replace target settings" })).toBeEnabled();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(copyDialog(page)).toHaveCount(0);
  expect(fixture.requests.filter(item => item.method === "POST")).toEqual([]);
  expect(await fixture.unexpectedWrites()).toEqual([]);
  expect(fixture.unexpectedTransports).toEqual([]);
});

test("confirmed copy uses the exact endpoint, blocks cancellation, and refreshes Member Preferences", async ({ page }) => {
  const fixture = await mount(page, { pending: true, includePreferences: true });
  await expect(page.getByTestId("text-page-title").filter({ hasText: "Member Preferences" })).toBeVisible();
  expect(fixture.runtimeErrors).toEqual([]);
  const targetPermission = page.getByTestId("fixture-target-permission");
  await expect(targetPermission).toHaveText("hidden");

  await page.getByTestId("button-copy-role-settings").click();
  await chooseRoles(page);
  await page.getByLabel(/I confirm replacing settings on Target Reviewers/).check();
  await page.getByRole("button", { name: "Replace target settings" }).click();
  await expect(page.getByRole("button", { name: "Copying settings…" })).toBeDisabled();
  await expect(copyDialog(page).getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect.poll(() => fixture.requests.filter(item => item.method === "POST").length).toBe(1);
  fixture.releaseCopy();

  await expect(copyDialog(page)).toHaveCount(0);
  await expect(page.getByText("Role settings copied. Open the target role to review its updated settings.")).toBeVisible();
  expect(fixture.requests.find(item => item.method === "POST")).toEqual({
    method: "POST",
    path: "/api/admin/roles/copy-settings",
    body: {
      sourceRoleId: "00000000-0000-4000-8000-000000000001",
      targetRoleId: "00000000-0000-4000-8000-000000000002",
    },
  });
  await expect.poll(() => fixture.requests.filter(item => item.method === "GET").length).toBeGreaterThan(1);
  await expect(targetPermission).toHaveText("read");
  await expect(page.getByText(/Unsaved permission edits were discarded/)).toBeVisible();
  expect(await fixture.unexpectedWrites()).toEqual([]);
  expect(fixture.unexpectedTransports).toEqual([]);
});

test("backend rejection keeps confirmation context open and exposes its error", async ({ page }) => {
  const fixture = await mount(page, {
    failureStatus: 403,
    failureMessage: "You are not allowed to copy settings for this tenant",
  });
  await page.getByTestId("button-copy-role-settings").click();
  await chooseRoles(page);
  await page.getByLabel(/I confirm replacing settings on Target Reviewers/).check();
  await page.getByRole("button", { name: "Replace target settings" }).click();

  await expect(copyDialog(page)).toBeVisible();
  await expect(copyDialog(page).getByRole("alert")).toHaveText(
    "You are not allowed to copy settings for this tenant",
  );
  await expect(page.getByLabel("Copy from (source role)")).toHaveValue("00000000-0000-4000-8000-000000000001");
  await expect(page.getByLabel("Replace settings on (target role)")).toHaveValue("00000000-0000-4000-8000-000000000002");
  expect(fixture.requests.filter(item => item.method === "POST")).toHaveLength(1);
  expect(await fixture.unexpectedWrites()).toEqual([]);
  expect(fixture.unexpectedTransports).toEqual([]);
});

test("an HTTP success without authoritative role evidence is treated as failure", async ({ page }) => {
  await mount(page, { malformedSuccess: true });
  await page.getByTestId("button-copy-role-settings").click();
  await chooseRoles(page);
  await page.getByLabel(/I confirm replacing settings on Target Reviewers/).check();
  await page.getByRole("button", { name: "Replace target settings" }).click();
  await expect(copyDialog(page).getByRole("alert")).toHaveText(
    "Failed to copy role settings. Reload the roles before retrying.",
  );
  await expect(copyDialog(page)).toBeVisible();
});