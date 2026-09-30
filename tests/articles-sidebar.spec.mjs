import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import path from "node:path";

let script, css;
const applicable = { id: "category", name: "Topics", is_active: true, applies_to_content_types: ["Articles"], subcategories: ["Research"] };
test.beforeAll(async () => {
  const mocks = {
    "@/api/base44Client": `export const base44 = window.fixture.api;`,
    "@/api/publicClient": `export const publicClient = window.fixture.publicApi;`,
    "@/lib/queryClient": `export const apiRequest = async () => ({counts:{}});`,
    "@/hooks/useMemberAccess": `export const useMemberAccess = () => ({memberInfo:window.fixture.member,isFeatureExcluded:()=>false});`,
    "@/hooks/useBlogPostRealtime": `export const useBlogPostRealtime = () => {};`,
    "@/contexts/ArticleUrlContext": `export const useArticleUrl = () => ({getArticleEditorUrl:()=>"/ArticleEditor"});`,
    "@/contexts/LayoutContext": `export const useLayoutContext = () => ({sessionValidated:!!window.fixture.member,hasBanner:false});`,
    "@/contexts/TenantBrandingContext": `export const useTenantBranding = () => ({});`,
    "../components/blog/ArticleCard": `import React from "react"; export default ({article}) => <div data-testid="article-card">{article.title}</div>;`,
    "../components/blog/FollowedAuthorsCard": `import React from "react"; export default ({memberInfo}) => memberInfo ? <div>Followed authors fixture</div> : null;`,
  };
  const result = await build({
    stdin: {
      contents: `import React from "react"; import {createRoot} from "react-dom/client";
        import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
        import {MemoryRouter} from "react-router-dom";
        import Articles from "./client/src/pages/Articles.jsx";
        const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
        window.reloadCategories = () => client.invalidateQueries({queryKey:["resourceCategories-articles"]});
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={client}><MemoryRouter><Articles/></MemoryRouter></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: "jsx",
    },
    bundle: true, write: false, jsx: "automatic",
    alias: { "@": path.resolve("client/src") },
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{
      name: "fixture-boundaries",
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : null);
        build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "jsx", resolveDir: process.cwd() }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: ["client/src/pages/Articles.jsx", "client/src/components/blog/ArticleFilter.jsx", "client/src/components/ui/*.{jsx,tsx}"],
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

async function mount(page, { categories = [], signedIn = false, empty = false, delayed = false, saved = [] } = {}) {
  await page.route("https://articles.test/**", route => route.fulfill({ contentType: "text/html", body: '<html><body><div id="root"></div></body></html>' }));
  await page.goto("https://articles.test/Articles");
  await page.evaluate(({ categories, signedIn, empty, delayed, saved }) => {
    const articles = empty ? [] : Array.from({ length: 8 }, (_, i) => ({
      id: String(i), title: `Article ${i}`, status: "published", author_id: "member",
      published_date: "2026-01-01", subcategories: i % 2 ? [] : ["Research"],
    }));
    const fixture = window.fixture = { categories, member: signedIn ? { id: "member" } : null, writes: [] };
    let resolve;
    const gate = delayed ? new Promise(r => { resolve = r; }) : Promise.resolve();
    window.releaseCategories = () => resolve();
    const listCategories = async () => { await gate; return fixture.categories; };
    fixture.api = {
      auth: {
        me: async () => ({ preferences: { resources: { selectedSubcategories: saved } } }),
        updateMe: async value => fixture.writes.push(value),
      },
      entities: {
        BlogPost: { list: async () => articles },
        ResourceCategory: { list: listCategories },
        ArticleReaction: { list: async () => [] },
        ButtonStyle: { list: async () => [] },
        SystemSettings: { list: async () => [] },
        Member: { get: async () => ({ first_name: "Author" }) },
      },
    };
    fixture.publicApi = {
      listArticles: async () => ({ articles, authors: {}, guestWriters: {} }),
      listResourceCategories: listCategories,
      listButtonStyles: async () => [],
      getSystemSetting: async () => null,
    };
    window.fetch = async () => ({ ok: true, json: async () => ({ authors: {} }) });
  }, { categories, signedIn, empty, delayed, saved });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
}

for (const width of [1440, 390]) {
  for (const signedIn of [false, true]) {
    test(`loaded empty centered at ${width}px signedIn=${signedIn}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await mount(page, { signedIn, categories: [
        { ...applicable, is_active: false },
        { ...applicable, applies_to_content_types: ["Resources"] },
        { ...applicable, applies_to_content_types: null },
      ] });
      const content = page.getByTestId("articles-content");
      await expect(content).toBeVisible();
      await expect(page.getByTestId("articles-sidebar")).toHaveCount(0);
      await expect(page.getByText("No categories available")).toHaveCount(0);
      const box = await content.boundingBox();
      expect(Math.abs(box.x - (width - box.x - box.width))).toBeLessThan(2);
      await expect(page.getByTestId("article-card")).toHaveCount(6);
      await page.getByRole("button", { name: "2", exact: true }).click();
      await expect(page.getByTestId("article-card")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const cards = await page.getByTestId("article-card").all();
      const first = await cards[0].boundingBox(), second = await cards[1].boundingBox();
      expect(width > 1000 ? first.y === second.y : first.y < second.y).toBe(true);
    });
  }
}

for (const width of [1440, 390]) {
  for (const signedIn of [false, true]) {
test(`loading resolves to empty at ${width}px signedIn=${signedIn}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await mount(page, { delayed: true, empty: true, signedIn });
  await expect(page.locator(".animate-pulse")).toHaveCount(6);
  await expect(page.getByTestId("articles-content")).toHaveCount(0);
  await page.evaluate(() => window.releaseCategories());
  await expect(page.getByText("No articles found")).toBeVisible();
  await expect(page.getByTestId("articles-sidebar")).toHaveCount(0);
  const box = await page.getByTestId("articles-content").boundingBox();
  expect(Math.abs(box.x - (width - box.x - box.width))).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});
  }
}

for (const width of [1440, 390]) {
  test(`populated controls and saved defaults at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mount(page, { categories: [applicable], signedIn: true, saved: ["Research"] });
    await expect(page.getByTestId("articles-sidebar")).toBeVisible();
    await expect(page.getByLabel("Research", { exact: true })).toBeChecked();
    await expect(page.getByTestId("article-card")).toHaveCount(4);
    await expect(page.getByText("Followed authors fixture")).toBeVisible();
    // Preferences can arrive after the filter mounts; open its accordion if needed.
    if (await page.locator('[data-state="closed"]').filter({ has: page.getByLabel("Research", { exact: true }) }).count()) {
      await page.getByRole("button", { name: /Topics/ }).click();
    }
    await page.getByLabel("Research", { exact: true }).click();
    await expect(page.getByTestId("article-card")).toHaveCount(6);
    await page.getByRole("button", { name: "Save as Default" }).click();
    await expect.poll(() => page.evaluate(() => window.fixture.writes)).toEqual([{ preferences: { resources: { selectedCategory: "all", selectedSubcategories: [] } } }]);
    await page.getByTestId("button-my-articles-filter").click();
    await expect(page.getByTestId("button-add-article")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.evaluate(() => { window.fixture.categories = []; window.reloadCategories(); });
    await expect(page.getByTestId("articles-sidebar")).toHaveCount(0);
  });
}

test("guest populated categories retain filtering", async ({ page }) => {
  await mount(page, { categories: [applicable] });
  await page.getByRole("button", { name: "Topics", exact: true }).click();
  await page.getByLabel("Research", { exact: true }).click();
  await expect(page.getByTestId("article-card")).toHaveCount(4);
  await expect(page.getByTestId("button-my-articles-filter")).toHaveCount(0);
});