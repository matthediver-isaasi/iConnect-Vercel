import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const MICROSITE = {
  id: "ms-4569",
  name: "Task 4569 microsite",
  path_prefix: "branch",
  home_slug: "welcome",
  header_config: { retainedByEditor: "yes" },
  branding_config: {},
  footer_config: {},
};

const tenantBranding = {
  name: "Main site",
  headerLogoUrl: null,
  headerConfig: {},
  brandingConfig: {},
};

const micrositeBranding = {
  name: "Branch brand",
  headerLogoUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
  headerConfig: { logoDestination: "main_site_home" },
  brandingConfig: {},
};

const stubs = {
  "@/lib/adminFetch": `
    export const adminFetch = (...args) => window.__task4569.adminFetch(...args);
  `,
  "@/lib/installedFonts": `
    export const useInstalledFonts = () => ({ options: [] });
  `,
  "@/lib/micrositeFooterSource": `
    export const buildMicrositeFooterSourcePayload = () => ({ footer_source: "configured" });
  `,
  "@/components/branding/brandingShared": `
    export const DEFAULT_HEADER_GRADIENT_STOPS = [];
    export const DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS = [];
    export const NAV_FONT_WEIGHTS = [];
    export const getHeaderGradientStops = () => [];
    export const hydrateSecondaryBarConfig = value => value || {};
    export const hydrateFooterConfig = value => value || {};
    export const GradientStopsEditor = () => null;
    export const HeaderLinkControls = () => null;
    export const SecondaryBarControls = () => null;
    export const FooterControls = () => null;
  `,
  "@/contexts/TenantBrandingContext": `
    export const useTenantBranding = () => ({ branding: window.__task4569.tenantBranding });
  `,
  "@/api/publicClient": `
    export const publicClient = {
      listMicrosites: () => window.__task4569.listMicrosites(),
      getTenantBranding: prefix => window.__task4569.getTenantBranding(prefix),
      listNavigationItems: async () => [],
      getSystemSetting: async () => null,
      search: async () => ({ results: [] }),
    };
  `,
  "@/api/base44Client": `
    export const base44 = { entities: { Role: { get: async () => null } } };
  `,
  "@/hooks/useNavigationRealtime": `
    export const useNavigationRealtime = () => {};
  `,
  "@/hooks/useResolvedSocialIcons": `
    export const useResolvedSocialIcons = () => ({});
  `,
  "@/components/iedit/elements/IEditFormElement": `
    export default function IEditFormElement() { return null; }
  `,
  "@/lib/searchResultsBranding": `
    export const resolveSearchResultsBranding = () => ({});
  `,
  "@/lib/searchResultTypes": `
    export const searchResultTypeIconMap = {};
    export const getSearchResultTypeLabel = value => value;
    export const useArticleDisplayName = () => "Article";
  `,
  "@/lib/navigationItemDestination": `
    export const isPageLessParentMenu = () => false;
  `,
  "@/lib/publicHeaderLogin": `
    export const resolvePublicHeaderLink = (_config, label) => ({ label });
  `,
  "@/components/layouts/PublicLoginLink": `
    export default function PublicLoginLink() { return null; }
  `,
};

function fixturePlugin() {
  const resolveSource = (base) => {
    for (const candidate of [
      base,
      `${base}.jsx`,
      `${base}.js`,
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, "index.jsx"),
      path.join(base, "index.js"),
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return base;
  };
  return {
    name: "task-4569-fixtures",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@\// }, (args) => {
        if (stubs[args.path]) return { path: args.path, namespace: "task4569-stub" };
        return { path: resolveSource(path.resolve("client/src", args.path.slice(2))) };
      });
      buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolveSource(path.resolve("shared", args.path.slice("@shared/".length))),
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "task4569-stub" }, (args) => ({
        contents: stubs[args.path],
        loader: "jsx",
        resolveDir: process.cwd(),
      }));
    },
  };
}

let script;
let css;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { BrowserRouter, Link } from "react-router-dom";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import MicrositeChromeEditor from "./client/src/components/microsites/MicrositeChromeEditor.jsx";
        import PublicHeader from "./client/src/components/layouts/PublicHeader.jsx";
        import { MicrositeProvider } from "./client/src/contexts/MicrositeContext.jsx";

        function EditorFixture() {
          const [version, setVersion] = useState(0);
          return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <BrowserRouter>
              <button data-testid="reopen-editor" onClick={() => setVersion(v => v + 1)}>Reopen editor</button>
              <MicrositeChromeEditor key={version} microsite={{...window.__task4569.editorMicrosite}} />
            </BrowserRouter>
          </QueryClientProvider>;
        }

        function TransitionControl() {
          return <Link data-testid="reenter-microsite" to="/branch/article">Re-enter microsite</Link>;
        }

        function HeaderFixture() {
          return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <BrowserRouter>
              <MicrositeProvider>
                <TransitionControl />
                <PublicHeader />
              </MicrositeProvider>
            </BrowserRouter>
          </QueryClientProvider>;
        }

        createRoot(document.getElementById("root")).render(
          window.__task4569.mode === "editor" ? <EditorFixture /> : <HeaderFixture />
        );
      `,
      resolveDir: process.cwd(),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    plugins: [fixturePlugin()],
    define: {
      "process.env.NODE_ENV": '"test"',
      "import.meta.env.DEV": "false",
    },
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: [
      "client/src/components/layouts/PublicHeader.jsx",
      "client/src/components/microsites/MicrositeChromeEditor.jsx",
      "client/src/components/ui/{button,card,input,label,select,switch,textarea,dialog}.jsx",
    ],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

async function mountEditor(page) {
  await page.setContent('<html><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.evaluate(({ microsite, branding }) => {
    const state = {
      mode: "editor",
      editorMicrosite: structuredClone(microsite),
      tenantBranding: branding,
      writes: [],
      listMicrosites: async () => [],
      getTenantBranding: async () => ({ success: true, branding }),
    };
    state.adminFetch = async (url, options = {}) => {
      if (url === "/api/admin/canvas-footers") {
        return new Response(JSON.stringify({ footers: [] }), { status: 200 });
      }
      if (url.startsWith("/api/admin/microsites?") && options.method === "PATCH") {
        const body = JSON.parse(options.body);
        state.writes.push(body);
        state.editorMicrosite = {
          ...state.editorMicrosite,
          header_config: body.header_config,
          branding_config: body.branding_config,
          footer_config: body.footer_config,
        };
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error("Unexpected task 4569 admin request: " + url);
    };
    window.__task4569 = state;
    window.fetch = async (url) => {
      if (String(url) === "/api/public/tenant-branding") {
        return new Response(JSON.stringify({ branding }), { status: 200 });
      }
      throw new Error("Unexpected task 4569 fetch: " + url);
    };
  }, { microsite: MICROSITE, branding: tenantBranding });
  await page.addScriptTag({ content: script });
}

async function chooseDestination(page, label) {
  await page.getByTestId("select-ms-logo-destination").click();
  await page.getByRole("option", { name: label }).click();
}

test("editor saves, reopens, and resets destination independently of logo appearance overrides", async ({ page }, testInfo) => {
  await mountEditor(page);
  const destination = page.getByTestId("select-ms-logo-destination");
  await expect(destination).toContainText("Microsite home (default)");
  await expect(page.getByTestId("switch-override-header-logo")).not.toBeChecked();

  await chooseDestination(page, "Main site home (/)");
  await page.getByTestId("button-save-chrome").click();
  await expect.poll(() => page.evaluate(() => window.__task4569.writes.length)).toBe(1);
  let first = await page.evaluate(() => window.__task4569.writes[0]);
  expect(first.header_config).toMatchObject({
    retainedByEditor: "yes",
    logoDestination: "main_site_home",
  });
  expect(first.header_config).not.toHaveProperty("logoHeight");

  await page.getByTestId("reopen-editor").click();
  await expect(destination).toContainText("Main site home (/)");
  await expect(page.getByTestId("switch-override-header-logo")).not.toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("task-4569-editor-fixture.png"),
    fullPage: true,
  });

  await page.getByTestId("switch-override-header-logo").click();
  await page.getByTestId("input-ms-header-logo-height").fill("84");
  await chooseDestination(page, "Microsite home (default)");
  await page.getByTestId("switch-override-header-logo").click();
  await page.getByTestId("button-save-chrome").click();
  await expect.poll(() => page.evaluate(() => window.__task4569.writes.length)).toBe(2);
  const reset = await page.evaluate(() => window.__task4569.writes[1]);
  expect(reset.header_config).toEqual({ retainedByEditor: "yes" });

  await page.getByTestId("reopen-editor").click();
  await expect(destination).toContainText("Microsite home (default)");
  await expect(page.getByTestId("switch-override-header-logo")).not.toBeChecked();
});

async function mountHeader(page, {
  logoUrl,
  logoDestination = "main_site_home",
  viewport = { width: 1280, height: 800 },
  injected = true,
} = {}) {
  await page.setViewportSize(viewport);
  await page.route("http://task4569.test/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: '<html><body><div id="root"></div></body></html>',
  }));
  await page.goto("http://task4569.test/branch/article");
  await page.addStyleTag({ content: css });
  await page.evaluate(({ microsite, tenant, branch, logoUrl, logoDestination, injected }) => {
    const merged = {
      ...branch,
      headerLogoUrl: logoUrl,
      headerConfig: { ...branch.headerConfig, logoDestination },
    };
    if (logoDestination === null) delete merged.headerConfig.logoDestination;
    if (injected) window.__MICROSITE_CONTEXT__ = { activeMicrosite: microsite, branding: merged };
    else delete window.__MICROSITE_CONTEXT__;
    const state = {
      mode: "header",
      tenantBranding: tenant,
      micrositeListCalls: 0,
      brandingCalls: 0,
    };
    state.listMicrosites = async () => {
      state.micrositeListCalls += 1;
      return { microsites: [microsite] };
    };
    state.getTenantBranding = async () => {
      state.brandingCalls += 1;
      return { success: true, branding: merged };
    };
    window.__task4569 = state;
  }, {
    microsite: MICROSITE,
    tenant: tenantBranding,
    branch: micrositeBranding,
    logoUrl,
    logoDestination,
    injected,
  });
  await page.addScriptTag({ content: script });
}

for (const [variant, logoUrl] of [
  ["image", micrositeBranding.headerLogoUrl],
  ["text", null],
]) {
  test(`PublicHeader routes desktop and mobile ${variant} logos and clears injected microsite chrome on root transition`, async ({ page }) => {
    await mountHeader(page, { logoUrl });
    const desktop = page.getByTestId("link-header-logo");
    const mobile = page.getByTestId("link-header-logo-mobile");
    await expect(desktop).toHaveAttribute("href", "/");
    await expect(desktop).toBeVisible();
    await expect(mobile).toBeHidden();
    if (variant === "image") await expect(desktop.locator("img")).toHaveAttribute("alt", "Branch brand");
    else await expect(desktop).toContainText("Branch brand");

    await desktop.click();
    await expect(page).toHaveURL("http://task4569.test/");
    await expect(desktop).toContainText("Main site");
    await page.getByTestId("reenter-microsite").click();
    await expect(page).toHaveURL("http://task4569.test/branch/article");
    await expect(desktop).toHaveAttribute("href", "/");
    if (variant === "image") await expect(desktop.locator("img")).toHaveAttribute("alt", "Branch brand");
    else await expect(desktop).toContainText("Branch brand");

    await page.setViewportSize({ width: 390, height: 760 });
    await expect(desktop).toBeHidden();
    await expect(mobile).toBeVisible();
    await expect(mobile).toHaveAttribute("href", "/");
    if (variant === "image") await expect(mobile.locator("img")).toHaveAttribute("alt", "Branch brand");
    else await expect(mobile).toContainText("Branch brand");

    await mobile.click();
    await expect(page).toHaveURL("http://task4569.test/");
    await expect(mobile).toHaveAttribute("href", "/");
    await expect(mobile).toContainText("Main site");
    await expect(mobile.locator("img")).toHaveCount(0);

    await page.getByTestId("reenter-microsite").click();
    await expect(page).toHaveURL("http://task4569.test/branch/article");
    await expect(mobile).toHaveAttribute("href", "/");
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByTestId("link-mobile-drawer-logo");
    await expect(drawer).toHaveAttribute("href", "/");
    await drawer.click();
    await expect(page).toHaveURL("http://task4569.test/");
    await expect(mobile).toContainText("Main site");
  });
}

test("PublicHeader default/absent destination routes all logo variants to microsite home", async ({ page }) => {
  await mountHeader(page, { logoUrl: null, logoDestination: null });
  await expect(page.getByTestId("link-header-logo")).toHaveAttribute("href", "/branch/welcome");
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(page.getByTestId("link-header-logo-mobile")).toHaveAttribute("href", "/branch/welcome");
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByTestId("link-mobile-drawer-logo")).toHaveAttribute("href", "/branch/welcome");
});

test("PublicHeader resolves client-fetched microsite branding without injected context", async ({ page }) => {
  await mountHeader(page, {
    logoUrl: micrositeBranding.headerLogoUrl,
    logoDestination: "main_site_home",
    injected: false,
  });
  const desktop = page.getByTestId("link-header-logo");
  await expect(desktop).toHaveAttribute("href", "/");
  await expect(desktop.locator("img")).toHaveAttribute("alt", "Branch brand");
  await expect.poll(() => page.evaluate(() => window.__task4569.micrositeListCalls)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__task4569.brandingCalls)).toBeGreaterThan(0);

  await desktop.click();
  await expect(page).toHaveURL("http://task4569.test/");
  await expect(desktop).toContainText("Main site");
  await page.getByTestId("reenter-microsite").click();
  await expect(page).toHaveURL("http://task4569.test/branch/article");
  await expect(desktop.locator("img")).toHaveAttribute("alt", "Branch brand");
});